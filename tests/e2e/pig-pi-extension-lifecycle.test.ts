import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { withExtension, type ConversationView } from '../helpers/pi-extension-fixture.ts';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A Pi extension is a participant in a session, not just a tool provider.
 *
 * The host owes it the two events the Pi API defines - session_start once, and
 * before_agent_start per turn - and it owes it a working directory that is the
 * workspace it serves. Measured 2026-11-02: the first was never sent (pi-fff
 * answered every search with "FFF picker factory is not initialized"), and the
 * second was the scratch directory (once session_start landed, the same search
 * returned a file from ~/.graph/tmp).
 */

// A Pi extension is told its session started, before any of its tools is called.
//
// Measured 2026-11-02: every installed Pi extension (pi-fff, agent-browser,
// mcp-adapter) builds its state in `pi.on('session_start')`. The daemon's host
// never emitted the event, so a stateful extension answered from a state nobody
// built - pi-fff rejected every search with "FFF picker factory is not
// initialized" while its tool stayed callable.
//
// The order is the assertion: the extension writes each lifecycle line it hears
// into one file, and the file must start with session_start. One host serves
// every session, so a second turn must not initialize it again.
const lifecycleExtensionSource = `import { appendFileSync } from 'node:fs';

export default function (pi) {
  const log = (line) => {
    try {
      if (process.env.GRAPH_PIG_PI_EXTENSION_MARKER) appendFileSync(process.env.GRAPH_PIG_PI_EXTENSION_MARKER, line + '\\n');
    } catch {}
  };
  pi.on('session_start', async () => { log('session_start'); });
  pi.on('before_agent_start', async (event) => {
    const prompt = String((event && event.prompt) || '').replace(/\\s+/g, ' ').trim();
    log('before_agent_start prompt=' + prompt);
  });
  pi.registerTool({
    name: 'proof_tool',
    description: 'Record that a turn called it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      log('tool');
      return { content: [{ type: 'text', text: 'extension-proof' }] };
    },
  });
}
`;

test('a Pi extension hears session_start before its first tool call, once per host', async () => {
  await withExtension(lifecycleExtensionSource, [{ name: 'proof_tool', description: 'Record that a turn called it.' }], async ({ daemon, capabilityDirectory }) => {
    const marker = join(capabilityDirectory, 'tool-ran.txt');
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Call the proof tool.', requestId: 'lifecycle-first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    await expect.poll(async () => (await view()).master?.status, { timeout: 60000, interval: 250 }).toBe('succeeded');

    const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Call the proof tool again.', requestId: 'lifecycle-second' }),
    });
    expect(second.status).toBe(200);
    await expect.poll(async () => (await view()).messages?.filter(message => message.role === 'assistant').length, { timeout: 60000, interval: 250 })
      .toBeGreaterThanOrEqual(2);

    const lines = (await readFile(marker, 'utf8')).split('\n').filter(Boolean);
    // The event arrived before the work: an extension initializes its state on
    // session_start, and a tool that runs first runs against nothing.
    expect(lines[0]).toBe('session_start');
    // One host serves every session of the daemon, so the second turn must not
    // initialize the extension again.
    expect(lines.filter(line => line === 'session_start')).toHaveLength(1);
    // Both turns really reached the extension.
    expect(lines.filter(line => line === 'tool')).toHaveLength(2);
    // The per-turn half of the contract: before_agent_start arrives before that
    // turn's tools, carrying the prompt the turn answers.
    const turnStarts = lines.filter(line => line.startsWith('before_agent_start'));
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0]).toContain('Call the proof tool.');
    expect(turnStarts[1]).toContain('again');
    expect(lines.indexOf(turnStarts[0]!)).toBeLessThan(lines.indexOf('tool'));
    expect(lines.indexOf(turnStarts[1]!)).toBeGreaterThan(lines.indexOf('tool'));
  }, undefined, [
    { tools: [{ id: 'call-proof', name: 'proof_tool', arguments: JSON.stringify({}) }] },
    { text: 'The extension answered.' },
    { tools: [{ id: 'call-proof-again', name: 'proof_tool', arguments: JSON.stringify({}) }] },
    { text: 'The extension answered again.' },
  ]);
}, 180_000);

// An extension works in the directory of the session it serves.
//
// Measured 2026-11-02: one host served every session, so every extension
// inherited one scratch cwd. It became visible the moment the host learned to
// emit session_start: pi-fff started answering, and the answer was a file from
// `~/.graph/tmp` instead of the repository. An extension resolves its index, its
// writes and its browser against its cwd, so the cwd has to be the workspace of
// the session that bound it.
const cwdExtensionSource = `import { appendFileSync } from 'node:fs';

export default function (pi) {
  const log = (line) => {
    try {
      if (process.env.GRAPH_PIG_PI_EXTENSION_MARKER) appendFileSync(process.env.GRAPH_PIG_PI_EXTENSION_MARKER, line + '\\n');
    } catch {}
  };
  pi.on('session_start', async (_event, ctx) => { log('session_start cwd=' + (ctx && ctx.cwd) + ' pwd=' + process.cwd()); });
  pi.registerTool({
    name: 'cwd_proof',
    description: 'Say which directory this extension process works in.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const cwd = process.cwd();
      log('tool pwd=' + cwd);
      return { content: [{ type: 'text', text: cwd }] };
    },
  });
}
`;

test('each workspace gets an extension host whose cwd is that workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-extension-cwd-'));
  const projectA = join(root, 'alpha');
  const projectB = join(root, 'beta');
  const home = join(root, 'graph-home');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(home);
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');

  const capabilityDirectory = join(home, 'capabilities', 'pi-extension', 'proof-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'index.mjs'), cwdExtensionSource);
  await writeFile(join(capabilityDirectory, 'capability.json'), JSON.stringify({
    id: 'proof', kind: 'pi-extension', version: '1.0.0', name: 'Proof extension',
    entry: './index.mjs', tools: [{ name: 'cwd_proof', description: 'Say which directory this extension process works in.' }],
  }));
  await writeFile(join(home, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main', name: 'Main', description: 'The main agent with a Pi extension.',
      recommendedGrade: 'high', review: false, tags: [],
      resources: [{ resourceId: 'proof', version: '1.0.0', role: 'pi-extension', required: false }],
    }],
  }));
  const marker = join(capabilityDirectory, 'tool-ran.txt');
  const provider = await openaiServer([
    { tools: [{ id: 'cwd-a', name: 'cwd_proof', arguments: JSON.stringify({}) }] },
    { text: 'A answered.' },
    { tools: [{ id: 'cwd-b', name: 'cwd_proof', arguments: JSON.stringify({}) }] },
    { text: 'B answered.' },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'a', root: projectA }, { id: 'b', root: projectB }],
      credentials: { local: { secretRef: 'GRAPH_PIG_CWD_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: {
      GRAPH_PIG_CWD_KEY: 'synthetic-only',
      GRAPH_PIG_PI_EXTENSION_MARKER: marker,
    }, extraArgs: ['--execute', '--kernel', 'pig'] });
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const server = daemon;
    for (const project of ['a', 'b']) {
      const created = await server.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: project, model: 'main', text: `Work in ${project}.`, requestId: `cwd-${project}` }) });
      expect(created.status, JSON.stringify(await created.clone().text())).toBe(200);
      const { conversationId } = await created.json() as { conversationId: string };
      const view = async () => await (await server.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
      await expect.poll(async () => (await view()).master?.status, { timeout: 60000, interval: 250 }).toBe('succeeded');
    }

    const lines = (await readFile(marker, 'utf8')).split('\n').filter(Boolean);
    const tools = lines.filter(line => line.startsWith('tool pwd=')).map(line => line.slice('tool pwd='.length));
    // One host per workspace: the extension of project A works in A, the one of
    // project B works in B (the same reason pi-fff must index the right tree).
    expect(tools).toContain(projectA);
    expect(tools).toContain(projectB);
    expect(lines.filter(line => line.startsWith('session_start')).length).toBeGreaterThanOrEqual(2);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
