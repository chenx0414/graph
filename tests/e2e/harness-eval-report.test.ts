import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_COMMON_RULES } from '../../src/runtime/agent-context.ts';
import { behaviorCases } from '../../scripts/harness-behavior-cases.mjs';
import { startBehaviorProvider } from '../../scripts/harness-behavior-model.mjs';

const execute = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** The runner as the loop calls it, with the exit code kept. */
async function runReport(configPath: string, surface: string, ledger: string, report: string) {
  try {
    const { stdout, stderr } = await execute(process.execPath, ['scripts/harness-eval-report.mjs',
      '--config', configPath, '--surface', surface, '--ledger', ledger, '--report', report,
      '--cases', 'parser', '--timeout', '30000'], {
      cwd: process.cwd(), timeout: 240000, env: { ...process.env, GRAPH_EVAL_LOCAL_KEY: 'harness-eval-fixture-key' },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** A graph home the runner can freeze: a main recipe and a rules file. */
async function surface(root: string, rules: string) {
  const home = join(root, 'surface');
  await mkdir(join(home, 'prompts', 'rules'), { recursive: true });
  await writeFile(join(home, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{ id: 'main', mode: 'main', name: 'Main', description: 'Handle the requested project work.', recommendedGrade: 'high', review: false, tags: [], resources: [] }],
  }));
  await writeFile(join(home, 'prompts', 'rules', 'common.md'), `${rules}\n`);
  return home;
}

test('the real-model evaluation records a verdict per case and names the case that regressed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-eval-report-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  // The model is the one external thing the evaluation talks to, so the
  // fixture stands in for it: the same scripted agent the behaviour gate uses.
  const provider = await startBehaviorProvider(behaviorCases.parser!);
  cleanup.push(() => provider.close());

  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_EVAL_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 256,
      credentialId: 'local', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  }));

  const ledger = join(root, 'ledger.json');
  const report = join(root, 'report.json');

  // The harness as it ships: the case is carried out and the verdict kept.
  const good = await surface(root, DEFAULT_COMMON_RULES);
  const green = await runReport(configPath, good, ledger, report);
  expect(green.code).toBe(0);
  expect(green.output).toContain('parser: pass');
  const first = JSON.parse(await readFile(ledger, 'utf8')) as { runs: { cases: Record<string, { verdict: string }>; surfaceFingerprint: string }[] };
  expect(first.runs[0]!.cases.parser!.verdict).toBe('pass');
  expect(first.runs[0]!.surfaceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  const written = JSON.parse(await readFile(report, 'utf8')) as { results: { caseId: string; verdict: string }[] };
  expect(written.results[0]!.caseId).toBe('parser');
  expect(written.results[0]!.verdict).toBe('pass');

  // The harness loses the rule that tells the agent how to make a precise
  // change: the case stops passing, and the runner says it regressed.
  const broken = await surface(root, DEFAULT_COMMON_RULES.split('\n').filter(rule => !rule.includes('Use edit for precise changes')).join('\n'));
  const red = await runReport(configPath, broken, ledger, report);
  expect(red.code).not.toBe(0);
  expect(red.output).toContain('parser: fail (regressed)');
  expect(red.output).toContain('regressed: parser');
  const second = JSON.parse(await readFile(ledger, 'utf8')) as { runs: { cases: Record<string, { verdict: string }> }[] };
  expect(second.runs[0]!.cases.parser!.verdict).toBe('fail');
  // The earlier run is still in the ledger: the history is what makes the
  // regression readable.
  expect(second.runs[1]!.cases.parser!.verdict).toBe('pass');
}, 600_000);
