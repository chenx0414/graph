// graph:allow-large-file: its 24 KB predate the budget; this change replaces one case and splits nothing else
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The self-improvement surface, proven against a real checkout.
 *
 * The Agent that maintains Graph may change Graph itself: it edits files in
 * the source checkout, runs the project's own checks and commits the result to
 * a dedicated branch. A model that gets the shape of the call wrong is told
 * exactly what is wrong - in the model's own terms - and nothing is changed
 * while it is wrong. A call that is right changes the real Git history of a
 * real repository, and a call that asks for a reload leaves a real reload
 * request behind.
 *
 * The proof is the real Go process, a real Git checkout and a real check
 * command. Nothing here is a stand-in for the improvement service.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id: string; name: string; arguments: string }

/** The provider that plays the master: one scripted answer per master turn. */
async function masterProvider(steps: ToolCall[][]) {
  const observed = new Map<string, string>();
  const requests: unknown[] = [];
  let stage = 0;
  let description = '';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: { function: { name: string; description: string } }[];
      messages: { role: string; content: unknown; tool_call_id?: string }[];
    };
    requests.push(body);
    const main = body.tools?.some(tool => tool.function.name === 'apply_rsi_change')
      && body.messages.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes('RSI workflow'));
    let calls: ToolCall[] = [];
    if (main) {
      description = body.tools!.find(tool => tool.function.name === 'apply_rsi_change')!.function.description;
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          observed.set(message.tool_call_id, typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content));
        }
      }
      calls = steps[stage] ?? [];
      stage++;
    }
    const delta = calls.length
      ? {
        role: 'assistant',
        tool_calls: calls.map((call, index) => ({
          index, id: call.id, type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
      : { role: 'assistant', content: main ? 'RSI workflow completed' : 'No suggestion' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    observed, requests, port,
    description: () => description,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function fixture(stepsFor: (initialCommit: string) => ToolCall[][]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-rsi-apply-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout, { recursive: true });
  const git = (args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  // The project's own gate: it reads the file the change writes, so a green run
  // proves the change, not just the process.
  const gate = "const fs=require('node:fs');if(!fs.existsSync('replace.txt')||fs.readFileSync('replace.txt','utf8')!=='corrected\\n')process.exit(1)";
  await writeFile(join(checkout, 'package.json'), JSON.stringify({
    name: 'rsi-apply-fixture', scripts: { check: `node -e "${gate}"` },
  }));
  await writeFile(join(checkout, 'replace.txt'), 'original\n');
  await writeFile(join(checkout, 'delete.txt'), 'remove me\n');
  await writeFile(join(checkout, 'mirror.txt'), 'revision content\n');
  // A large file the guard protects: a whole-file write that guts it is the
  // mistake the guard exists for.
  await writeFile(join(checkout, 'big.txt'), Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@local']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'initial']);
  const initialCommit = git(['rev-parse', 'HEAD']);
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await masterProvider(stepsFor(initialCommit));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_RSI_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      contextWindow: 32000, maxTokens: 4096, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    env: { GRAPH_RSI_ROOT: checkout, GRAPH_RSI_KEY: 'rsi-synthetic' },
    extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, checkout, git, initialCommit, provider, daemon, request };
}


async function startMasterConversation(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  const opened = await f.request('/api/orchestration/global', {
    method: 'POST',
    body: JSON.stringify({ requestId: `${requestId}-open` }),
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const { conversationId } = opened.body as { conversationId: string };
  const started = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'RSI workflow', requestId }),
  });
  return { ...started, body: { ...(started.body as Record<string, unknown>), conversationId } };
}

const base = { title: 'Correct native RSI call', problem: 'Exercise the real apply', activate: false };
const check = {
  command: 'node',
  args: ['-e', "if(require('node:fs').readFileSync('replace.txt','utf8')!=='corrected\\n')process.exit(1)"],
};

const malformed: { id: string; args: unknown }[] = [
  { id: 'nested-check', args: { ...base, changes: [{ path: 'a.ts', action: 'write', content: 'x', checks: [check] }] } },
  { id: 'nested-edit', args: { ...base, changes: [{ path: 'a.ts', action: 'replace', edits: [{ oldText: 'a', newText: 'b' }, { path: 'b.ts', action: 'write', content: 'y' }] }] } },
  { id: 'change-in-checks', args: { ...base, changes: [], checks: [{ path: 'a.ts', action: 'write', content: 'x' }] } },
  { id: 'missing-first', args: { ...base, changes: [{ action: 'replace', edits: [{ oldText: 'a', newText: 'b' }] }] } },
  { id: 'missing-second', args: { ...base, changes: [{ path: 'a.ts', action: 'write', content: 'x' }, { action: 'write', content: 'y' }] } },
  { id: 'array-change', args: { ...base, changes: [[{ path: 'a.ts', action: 'write', content: 'x' }]] } },
  { id: 'copy-no-revision', args: { ...base, changes: [{ path: 'mirror.txt', action: 'copy' }] } },
  { id: 'copy-path-revision', args: { ...base, changes: [{ path: 'mirror.txt', action: 'copy', from: 'main:src/a.ts' }] } },
  { id: 'blank-path', args: { ...base, changes: [{ path: '', action: 'delete' }] } },
  { id: 'scalar', args: 'not an object' },
];

function script(initialCommit: string): ToolCall[][] {
  const call = (id: string, args: unknown): ToolCall =>
    ({ id, name: 'apply_rsi_change', arguments: JSON.stringify(args) });
  return [
    [call('corrected', {
      ...base,
      changes: [
        { path: 'replace.txt', action: 'replace', edits: [{ oldText: 'original', newText: 'corrected' }] },
        { path: 'delete.txt', action: 'delete' },
        { path: 'mirror.txt', action: 'copy', from: initialCommit },
      ],
      checks: [check],
    })],
    [call('check-only', { ...base, changes: [], checks: [check] })],
  ];
}

/** The call that asks the host to run the new code. */
function activationScript(): ToolCall[][] {
  return [[{
    id: 'activate',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      title: 'Ask for the reload', problem: 'The change has to run', activate: true,
      changes: [
        { path: 'replace.txt', action: 'replace', edits: [{ oldText: 'original', newText: 'corrected' }] },
        { path: 'activated.txt', action: 'write', content: 'reloaded\n' },
      ],
      checks: [check],
    }),
  }]];
}

test('a console-only change builds the served page and never the app bundle', async () => {
  // Rebuilding the bundle rewrites /Applications/Graph.app, which changes its ad-hoc
  // code signature and costs the app its keychain grant - measured 2026-11-05 as the
  // "找不到用于储存 Graph Key 的钥匙串" alert on every self-improvement. A console change
  // is served from this checkout, so it must ask for the page and nothing else.
  const f = await fixture(() => [[{
    id: 'console',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      title: 'A console change', problem: 'The page has to move', activate: true,
      // The fixture's own gate reads replace.txt, so the change carries both files:
      // the console one is what the build decision is about.
      changes: [
        { path: 'replace.txt', action: 'replace', edits: [{ oldText: 'original', newText: 'corrected' }] },
        { path: 'src/web/probe.ts', action: 'write', content: 'export const probe = 1;\n' },
      ],
      checks: [check],
    }),
  }]]);

  const started = await startMasterConversation(f, 'rsi-console-only');
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const { conversationId } = started.body as { conversationId: string };

  // The fixture checkout has no vite project, so the page build itself fails; what
  // this case pins is the decision the daemon made, which the receipt records
  // either way.
  const commands = await (async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const view = await f.request(`/api/conversations/${conversationId}`);
      const messages = (view.body as { messages?: { kind: string; data?: { validation?: { command: string }[] } }[] }).messages ?? [];
      const receipt = messages.find(message => message.kind === 'rsi');
      const list = receipt?.data?.validation;
      if (list && list.length) return list.map(item => item.command);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return [];
  })();

  expect(commands.some(command => /build:web/.test(command)), `no page build was asked for: ${commands.join(' | ')}`).toBe(true);
  expect(commands.some(command => /app:build/.test(command)), `the app bundle was rebuilt: ${commands.join(' | ')}`).toBe(false);
}, 240_000);

test('a whole-file write that would gut a large file is refused and nothing is written', async () => {
  const f = await fixture(() => [[{
    id: 'gut',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      changes: [{ path: 'big.txt', action: 'write', content: 'stub\n' }],
      checks: [check],
    }),
  }]]);

  const started = await startMasterConversation(f, 'rsi-gut');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  // The refusal names the file and both sizes, so the caller can see what it was
  // about to do. The exact counts are the file's business, not the test's.
  await expect.poll(() => [...f.provider.observed.values()].join('\n'), { timeout: 90_000, interval: 250 })
    .toMatch(/RSI write to big\.txt would replace \d+ lines with \d+/);
  // The file is untouched and no commit was made for it.
  const lines = (await readFile(join(f.checkout, 'big.txt'), 'utf8')).split('\n').filter(Boolean);
  expect(lines).toHaveLength(300);
  expect(f.git(['log', '--oneline']).split('\n')).toHaveLength(1);
}, 120_000);

test('a wrong self-improvement call is explained and changes nothing', async () => {
  const f = await fixture(() => [malformed.map(entry => ({
    id: entry.id, name: 'apply_rsi_change', arguments: JSON.stringify(entry.args),
  }))]);

  const started = await startMasterConversation(f, 'rsi-malformed');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  await expect.poll(() => f.provider.observed.size, { timeout: 90_000, interval: 250 })
    .toBeGreaterThanOrEqual(malformed.length);

  // Every wrong shape is named back to the model, down to the field that is
  // wrong: the call the model can correct is the one it gets.
  const observed = f.provider.observed;
  expect(observed.get('nested-check'), 'nested-check').toMatch(/changes\[0\] is one file change[\s\S]*"checks" belongs at the top level/);
  expect(observed.get('nested-edit'), 'nested-edit').toMatch(/changes\.0\.edits\.1\.oldText: must have required properties/);
  expect(observed.get('change-in-checks'), 'change-in-checks').toMatch(/checks\.0\.command: must have required properties/);
  expect(observed.get('missing-first'), 'missing-first').toMatch(/changes\.0\.path: must have required properties path/);
  expect(observed.get('missing-second'), 'missing-second').toMatch(/changes\.1\.path: must have required properties path/);
  expect(observed.get('array-change'), 'array-change').toMatch(/changes\.0: must be object/);
  expect(observed.get('copy-no-revision'), 'copy-no-revision').toMatch(/changes\[0\]\.from must name the revision/);
  expect(observed.get('copy-path-revision'), 'copy-path-revision').toMatch(/changes\[0\]\.from must be a revision only/);
  expect(observed.get('blank-path'), 'blank-path').toMatch(/changes\[0\]\.path is required/);
  expect(observed.get('scalar'), 'scalar').toMatch(/must be object/);
  // The mistake is shown, not rewritten: the call that carried a scalar is
  // reported with the scalar it carried, not with an empty object.
  expect(observed.get('scalar'), 'scalar').toContain('not an object');

  // The tool description tells the model the shapes it may use.
  expect(f.provider.description()).toContain('"copy"');

  // Nothing was changed while the calls were wrong: no branch, no commit, no file.
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(f.git(['status', '--porcelain'])).toBe('');
  expect(f.git(['branch', '--list', 'rsi/*'])).toBe('');
  await expect(readFile(join(f.checkout, 'a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.checkout, 'replace.txt'), 'utf8')).toBe('original\n');
}, 180_000);

test('a right self-improvement call commits the real checkout', async () => {
  const f = await fixture(script);

  const started = await startMasterConversation(f, 'rsi-apply');
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const conversationId = (started.body as { conversationId: string }).conversationId;

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('corrected'), { timeout: 90_000, interval: 250 }).toBe(true);
  expect(observed.get('corrected')).toContain('"status":"applied"');
  expect(await readFile(join(f.checkout, 'replace.txt'), 'utf8')).toBe('corrected\n');
  await expect(readFile(join(f.checkout, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.checkout, 'mirror.txt'), 'utf8')).toBe('revision content\n');
  expect(f.git(['log', '--format=%s', '-1'])).toBe('rsi: Correct native RSI call');
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('2');
  expect(f.git(['status', '--porcelain'])).toBe('');
  // The change lives on its own branch, not on the line the daemon runs.
  expect(f.git(['branch', '--list', 'rsi/*'])).not.toBe('');

  // A call that changes nothing says so instead of claiming a commit.
  await expect.poll(() => observed.has('check-only'), { timeout: 90_000, interval: 250 }).toBe(true);
  expect(observed.get('check-only')).toContain('没有产生提交');
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('2');

  // The receipt is a message of the conversation, not a side channel. It carries
  // the price of the call itself: a real gate ran, so the number is real, and it
  // is the call's, not the reload's.
  const view = await f.request(`/api/conversations/${conversationId}`);
  const messages = (view.body as { messages?: { kind: string; data?: { status?: string; elapsedMs?: number; validation?: { status: string }[] } }[] }).messages ?? [];
  expect(messages.some(message => message.kind === 'rsi' && message.data?.status === 'applied'
    && message.data.validation?.every(item => item.status === 'passed'))).toBe(true);
  const applied = messages.find(message => message.kind === 'rsi' && message.data?.status === 'applied');
  expect(typeof applied?.data?.elapsedMs, 'the receipt carries no call duration').toBe('number');
  expect(applied?.data?.elapsedMs ?? 0).toBeGreaterThan(0);
}, 240_000);

test('a self-improvement call that asks for a reload leaves a real reload request behind', async () => {
  const f = await fixture(() => activationScript());

  const started = await startMasterConversation(f, 'rsi-activate');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const { conversationId } = started.body as { conversationId: string };
  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    const messages = (view.body as { messages?: { kind: string; data?: { restartRequired?: boolean; activation?: { state?: string } } }[] }).messages ?? [];
    return messages.some(message => message.kind === 'rsi' && message.data?.restartRequired === true && message.data.activation?.state === 'pending_reload');
  }, { timeout: 90_000, interval: 250 }).toBe(true);

  // The reload request names the commit that has to run.
  await expect.poll(async () => {
    try {
      const raw = await readFile(join(f.root, 'state', 'rsi', 'restart.json'), 'utf8');
      return JSON.parse(raw) as { commit?: string; branch?: string };
    } catch {
      return undefined;
    }
  }, { timeout: 60_000, interval: 250 }).toMatchObject({ commit: expect.any(String), branch: expect.stringContaining('rsi/') });
}, 240_000);

test('a file already written in the workspace is committed without retyping it', async () => {
  const f = await fixture(() => [[{
    id: 'adopt',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      changes: [
        { path: 'replace.txt', action: 'replace', edits: [{ oldText: 'original', newText: 'corrected' }] },
        // The Agent wrote and ran this file itself; it is untracked in the
        // checkout, and retyping it into the call is the cost this shape removes.
        { path: 'keeper.txt', action: 'write', fromPath: 'keeper.txt' },
      ],
      checks: [check],
    }),
  }]]);
  await writeFile(join(f.checkout, 'keeper.txt'), 'keeper content\n');

  const started = await startMasterConversation(f, 'rsi-adopt');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('adopt'), { timeout: 90_000, interval: 250 }).toBe(true);
  expect(observed.get('adopt')).toContain('"status":"applied"');
  // The committed bytes are the bytes that were on disk, now tracked.
  expect(await readFile(join(f.checkout, 'keeper.txt'), 'utf8')).toBe('keeper content\n');
  expect(f.git(['ls-files', 'keeper.txt'])).toBe('keeper.txt');
  expect(f.git(['log', '--format=%s', '-1'])).toBe('rsi: Correct native RSI call');
  expect(f.git(['status', '--porcelain'])).toBe('');
}, 180_000);

test('a batch whose anchors do not match names every bad edit and writes nothing', async () => {
  const f = await fixture(() => [[{
    id: 'several',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      changes: [{
        path: 'replace.txt',
        action: 'replace',
        edits: [
          // "i" occurs twice in "original\n": one edit matches many.
          { oldText: 'i', newText: 'I' },
          { oldText: 'original', newText: 'corrected' },
          // Nothing in the file contains this: one edit matches none.
          { oldText: 'zzz', newText: 'x' },
        ],
      }],
      checks: [check],
    }),
  }]]);

  const started = await startMasterConversation(f, 'rsi-several');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('several'), { timeout: 90_000, interval: 250 }).toBe(true);
  const message = observed.get('several') ?? '';
  // One resend has to be enough: both wrong anchors are named, not just the first.
  expect(message).toMatch(/edit 1 of 3/);
  expect(message).toMatch(/found 2/);
  expect(message).toMatch(/edit 3 of 3/);
  expect(message).toMatch(/found 0/);
  // Nothing was written and no commit was made.
  expect(await readFile(join(f.checkout, 'replace.txt'), 'utf8')).toBe('original\n');
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(f.git(['status', '--porcelain'])).toBe('');
}, 180_000);

test('another track\'s uncommitted work is left alone and stays out of the commit', async () => {
  // The gate this change runs must also prove the isolation: it fails when the
  // other track's untracked file is visible, and when a tracked file holds the
  // other track's edit instead of the committed one.
  const isolated = {
    command: 'node',
    args: ['-e', "const fs=require('node:fs');"
      + "if(!fs.existsSync('welcome.txt'))process.exit(1);"
      + "if(fs.readFileSync('welcome.txt','utf8')!=='hi\\n')process.exit(1);"
      + "if(fs.existsSync('stranger.txt'))process.exit(1);"
      + "if(fs.readFileSync('delete.txt','utf8')!=='remove me\\n')process.exit(1)"],
  };
  const f = await fixture(() => [[{
    id: 'stranger',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      changes: [{ path: 'welcome.txt', action: 'write', content: 'hi\n' }],
      checks: [isolated],
    }),
  }]]);
  // Measured 2026-11-02: a whole other track sat uncommitted in this checkout for
  // an hour, and every commit of mine was refused because of it. Both shapes are
  // here: an untracked file and an edit to a tracked one.
  await writeFile(join(f.checkout, 'stranger.txt'), 'someone else work\n');
  await writeFile(join(f.checkout, 'delete.txt'), 'someone else edits this\n');

  const started = await startMasterConversation(f, 'rsi-stranger');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('stranger'), { timeout: 90_000, interval: 250 }).toBe(true);
  const receipt = observed.get('stranger')!;
  expect(receipt, 'the change was refused instead of isolated').not.toMatch(/Uncommitted changes outside this RSI change/);
  expect(receipt).toMatch(/"status":"applied"|RSI 已提交/);

  // The commit holds exactly this change, and the other track's work is still
  // there, byte for byte, still uncommitted.
  expect(f.git(['show', '--pretty=format:', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort()).toEqual(['welcome.txt']);
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('2');
  expect(f.git(['status', '--porcelain', '--', 'stranger.txt'])).toBe('?? stranger.txt');
  expect(await readFile(join(f.checkout, 'stranger.txt'), 'utf8')).toBe('someone else work\n');
  // `git status` is read through a helper that trims, so the worktree marker has no
  // leading blank here; what matters is that the edit is still uncommitted.
  expect(f.git(['status', '--porcelain', '--', 'delete.txt'])).toBe('M delete.txt');
  expect(await readFile(join(f.checkout, 'delete.txt'), 'utf8')).toBe('someone else edits this\n');
  // What the change committed is what sits in the caller's checkout once it lands.
  expect(await readFile(join(f.checkout, 'welcome.txt'), 'utf8')).toBe('hi\n');
}, 180_000);

test('a path written in Chinese is committed like any other', async () => {
  // Measured 2026-11-03: `git diff --name-only` C-quotes a non-ASCII path by
  // default ("docs/\347\256\241..."), the ownership check compared that quoted
  // form with the path the change declared, and the change's own file read as
  // somebody else's uncommitted work. Every documentation file whose name is
  // Chinese was uncommittable through apply_rsi_change.
  const f = await fixture(() => [[{
    id: 'cjk',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      changes: [{ path: '说明.md', action: 'write', content: '# 说明\n' }],
      checks: [{ command: 'node', args: ['-e', "if(!require('node:fs').existsSync('说明.md'))process.exit(1)"] }],
    }),
  }]]);

  const started = await startMasterConversation(f, 'rsi-cjk');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('cjk'), { timeout: 90_000, interval: 250 }).toBe(true);
  const receipt = observed.get('cjk')!;
  expect(receipt, 'a non-ASCII path is not somebody else\'s work').not.toMatch(/Uncommitted changes outside this RSI change/);
  expect(receipt).toContain('"status":"applied"');
  expect(f.git(['-c', 'core.quotepath=false', 'show', '--pretty=format:', '--name-only', 'HEAD']).split('\n').filter(Boolean)).toEqual(['说明.md']);
  expect(await readFile(join(f.checkout, '说明.md'), 'utf8')).toBe('# 说明\n');
  expect(f.git(['status', '--porcelain'])).toBe('');
}, 180_000);

test('a dry run applies the change, runs the check and restores the checkout', async () => {
  const f = await fixture(() => [[{
    id: 'dry',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      dryRun: true,
      changes: [
        { path: 'replace.txt', action: 'replace', edits: [{ oldText: 'original', newText: 'corrected' }] },
        { path: 'draft.txt', action: 'write', content: 'draft\n' },
      ],
      checks: [check],
    }),
  }]]);

  const started = await startMasterConversation(f, 'rsi-dry');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('dry'), { timeout: 90_000, interval: 250 }).toBe(true);
  const receipt = observed.get('dry') ?? '';
  // The verdict is the point of the exercise: the check really ran on the
  // changed file, and the receipt says so.
  expect(receipt).toContain('"status":"dry_run"');
  expect(receipt).toContain('"status":"passed"');
  // Nothing is left behind: no committed change, no branch, no dirty file.
  expect(await readFile(join(f.checkout, 'replace.txt'), 'utf8')).toBe('original\n');
  await expect(readFile(join(f.checkout, 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(f.git(['status', '--porcelain'])).toBe('');
  expect(f.git(['branch', '--list', 'rsi/*'])).toBe('');
  expect(f.git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
}, 180_000);

test('a dry run that fails the gate still restores the checkout and never reloads', async () => {
  const f = await fixture(() => [[{
    id: 'dry-fail',
    name: 'apply_rsi_change',
    arguments: JSON.stringify({
      ...base,
      // activate is not named: its default is true, and a dry run must not act on it.
      dryRun: true,
      changes: [{ path: 'replace.txt', action: 'write', content: 'unrelated\n' }],
      checks: [check],
    }),
  }]]);

  const started = await startMasterConversation(f, 'rsi-dry-fail');
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const observed = f.provider.observed;
  await expect.poll(() => observed.has('dry-fail'), { timeout: 90_000, interval: 250 }).toBe(true);
  const receipt = observed.get('dry-fail') ?? '';
  expect(receipt).toContain('"status":"dry_run"');
  expect(receipt).toContain('"status":"failed"');
  expect(receipt).toContain('"restartRequired":false');
  // The failure teaches, it does not linger: the file is back and nothing waits
  // for a reload.
  expect(await readFile(join(f.checkout, 'replace.txt'), 'utf8')).toBe('original\n');
  expect(f.git(['status', '--porcelain'])).toBe('');
  expect(f.git(['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(f.git(['branch', '--list', 'rsi/*'])).toBe('');
  await expect(readFile(join(f.root, 'state', 'rsi', 'restart.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 180_000);
