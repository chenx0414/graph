import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { desktopProvider, envelopeOf, textOf } from '../helpers/desktop-graph.ts';

/**
 * P4 — a permission reading carries the execution context it was taken in.
 *
 * The tool asks `agent-desktop permissions` before a command that reads the
 * accessibility tree, and that probe answers with the TCC state of the process
 * that runs it. A refusal that says only "permission is not granted" would
 * report the *environment the reading was taken in* as the *user's setting*.
 *
 * This file proves, through the real daemon and a controlled agent-desktop CLI,
 * that the answer the model reads names that context: the reading is evidence
 * from the host, and the refusal still tells the model which grant is missing.
 *
 * The CLI here is a controlled external program, not a stub of Graph: it prints
 * the envelope `agent-desktop permissions` really prints, so the product's own
 * reading (state, version) stays the thing under test.
 */

const SENTINEL = 'PERMISSION-CONTEXT';

/** The agent-desktop CLI both sessions see: an existing binary, denying the grant. */
async function deniedBinary(root: string, argvLog: string): Promise<string> {
  const script = join(root, 'agent-desktop-denied.sh');
  const line = (value: string) => `printf '%s\\n' ${JSON.stringify(value)}`;
  await writeFile(script, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}`,
    `printf -- '---\\n' >> ${JSON.stringify(argvLog)}`,
    'case "$1" in',
    '  permissions)',
    `    ${line('{"version":"1.1.0","ok":true,"command":"permissions","data":{"accessibility":{"state":"denied"},"screenRecording":{"state":"denied"}}}')}`,
    '    ;;',
    '  *)',
    `    ${line('{"version":"1.1.0","ok":false,"command":"snapshot","error":{"code":"NO_TARGET","message":"no window"}}')}`,
    '    ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return script;
}

interface Refusal {
  refused: Record<string, any>;
  argv: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => { for (const close of cleanups.reverse()) await close(); });

/**
 * One daemon whose master turn calls `desktop snapshot` on a machine whose
 * grant probe answers `denied`.
 */
async function session(): Promise<Refusal> {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-permission-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# permission context\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'graph@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Graph Test'], { cwd: project });
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: project });

  const argvLog = join(root, 'desktop-argv.log');
  const binary = await deniedBinary(root, argvLog);
  const provider = await desktopProvider([{
    marker: SENTINEL,
    calls: [{ id: 'snapshot', args: { command: 'snapshot', include: 'output' } }],
  }]);
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { desktop: { secretRef: 'GRAPH_DESKTOP_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'desktop' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    env: {
      GRAPH_DESKTOP_KEY: 'desktop-synthetic', GRAPH_DESKTOP_BIN: binary,
      AGENT_DESKTOP_HOME: join(root, 'agent-desktop'),
    },
    extraArgs: ['--execute'],
  });
  cleanups.push(async () => { await daemon.close(); await provider.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await daemon.request('/api/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'main', text: `${SENTINEL}: take a snapshot`, requestId: 'open' }),
  });
  const body = await opened.text();
  if (opened.status !== 200) throw new Error(`the conversation did not open (${opened.status}): ${body}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const answer = provider.results.get('snapshot');
    if (answer) return { refused: envelopeOf(textOf(answer)), argv: await readFile(argvLog, 'utf8').catch(() => '') };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('the desktop tool never answered');
}

/**
 * Graph has one permission posture, so there is no sandboxed half to compare
 * against any more: this case keeps the host reading - the one that has to be
 * real evidence - and drops the contrast it used to draw with a standard
 * session. The probe, the envelope and the suggestion are what still matter.
 */
test('the host session reports its own reading as evidence', async () => {
  const host = await session();

  expect(host.argv.split('\n')[0], 'the host session did not probe the CLI').toBe('permissions');
  expect(host.refused.error?.code).toBe('PERM_DENIED');

  const hostContext = host.refused.error?.details?.executionContext;
  expect(hostContext, `expected error.details.executionContext on the host refusal; got ${JSON.stringify(host.refused.error?.details)}`)
    .toMatchObject({ evidence: 'host', probe: 'agent-desktop permissions' });
  expect(host.refused.error?.details?.accessibility).toBe('denied');
  expect(String(host.refused.error?.message), 'the host refusal must name the grant it read').toContain('not granted');
});
