import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The branch a graph works on.
 *
 * A branch name is something a user reads in their own repository, so it has
 * to be readable, safe for git, and different every time - and it must never
 * take a path that is already in use. The name comes from the task the user
 * asked for, so a Chinese task name has to become something a git branch can
 * carry.
 *
 * The proof is a real repository and real branches: the master Agent creates
 * the graphs, git creates the branches and the worktrees, and the names are
 * read back from the repository itself.
 */

const execute = promisify(execFile);

/** Real git, in a real repository. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, { cwd });
  return stdout.trim();
}

/** The task names and the branch-safe names they must become. */
const CASES: [string, string][] = [
  ['修复登录问题', 'xiu-fu-deng-lu-wen-ti'],
  ['新增导出功能', 'xin-zeng-dao-chu-gong-neng'],
  ['看板四态可视化', 'kan-ban-si-tai-ke-shi-hua'],
  ['Fix 修复 login 问题', 'fix-xiu-fu-login-wen-ti'],
  ['v2 重构 API', 'v2-zhong-gou-api'],
  ['修复  登录!!! 问题', 'xiu-fu-deng-lu-wen-ti'],
  ['龘龘', '龘-龘'],
  ['!!! ??? ...', 'task'],
  ['修复'.repeat(40), 'xiu-fu-xiu-fu-xiu-fu-xiu-fu-xiu-fu-xiu-f'],
  ['修复登录问题', 'xiu-fu-deng-lu-wen-ti'],
];

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

/** The master Agent. It plays the plan in order and records what every call answered. */
async function masterProvider(plan: (graphId: string) => { id: string; name: string; args: unknown }[]) {
  const results = new Map<string, string>();
  const served = new Map<string, string>();
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? '';
      if (base) results.set(base, content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan(graphId).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The branches are as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    served.set(next.id, next.id);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The node model. The worker answers the chat it was given. */
async function nodeProvider() {
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'My work copy is ready.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('graph and worker branches use readable safe unique names without overwriting occupied paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-branches-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), 'branch naming fixture\n');
  await git(project, ['init', '-q', '-b', 'feature/current']);
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The first turn creates the graphs; the second turn hands work to a
  // worker, after the test has taken the names the worker could have used.
  let phase: 'first' | 'second' = 'first';
  const master = await masterProvider(graphId => phase === 'first' ? [
    ...CASES.map(([name], index) => ({
      id: `create-${index}`,
      name: 'graph_create',
      args: {
        requestId: `graph-${index}`,
        targetBranch: 'feature/current',
        definition: {
          schemaVersion: 2, name, protocols: {},
          nodes: { worker: { recipe: 'coder@1', model: 'local', task: 'Observe branch naming', inputs: {}, outputs: {}, submission: {} } },
          modules: {}, edges: {}, inputs: {}, outputs: {},
        },
      },
    })),
  ] : [
    // The last graph gets work: its worker takes a work copy of its own.
    { id: 'send-worker', name: 'graph_send', args: { graphId, nodeId: 'worker', text: 'Observe my real work copy branch' } },
  ]);
  const node = await nodeProvider();
  const configPath = join(root, 'graph.config.json');
  const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'branch' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { branch: { secretRef: 'GRAPH_BRANCH_KEY' } },
    models: { entries: [
      { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...entry, id: 'local', provider: 'graph-node', modelId: 'node-model', baseUrl: node.baseUrl, contextWindow: 32000 },
    ] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_BRANCH_KEY: 'branch-synthetic' }, extraArgs: ['--execute'] });
  const created = await daemon.request('/api/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Name one branch per task.', requestId: 'branch-begin' }),
  });
  expect(created.status).toBe(200);
  const conversationId = (await created.json() as { conversationId: string }).conversationId;
  for (const [index] of CASES.entries()) {
    await expect.poll(() => master.results.get(`create-${index}`), { timeout: 120_000, interval: 250 }).toContain('graphId');
  }

  // Every graph got its own readable, safe and unique branch.
  const graphIds = CASES.map((_, index) => {
    const answer = master.results.get(`create-${index}`)!;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(answer);
    expect(found, `the graph ${index} was not created`).toBeTruthy();
    return found![1]!;
  });
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  const branches: string[] = [];
  try {
    for (const [index, [name, slug]] of CASES.entries()) {
      const graphId = graphIds[index]!;
      const shortId = graphId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8);
      const expected = `graph/task/${slug}-${shortId}`;
      const row = db.prepare('SELECT integration_branch FROM tasks WHERE id=?').get(graphId) as { integration_branch: string | null };
      expect(row.integration_branch, `the graph ${name} has no branch`).toBe(expected);
      // The name is a name git accepts.
      expect(await git(project, ['check-ref-format', '--branch', expected])).toBe(expected);
      expect(slug.length).toBeLessThanOrEqual(40);
      const tree = db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graphId}`) as { path: string };
      expect(basename(dirname(tree.path))).toBe(`${slug}-${shortId}`);
      expect(await git(tree.path, ['branch', '--show-current'])).toBe(expected);
      branches.push(expected);
    }
    // Ten graphs, ten different branches - even when two tasks read the same.
    expect(new Set(branches).size).toBe(CASES.length);

    // The worker's own copy takes a free name and leaves the occupied ones be.
    const lastGraph = graphIds[graphIds.length - 1]!;
    const integration = db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${lastGraph}`) as { path: string };
    const occupied = join(dirname(integration.path), 'worker');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'retained.txt'), 'do not overwrite');
    for (const suffix of [2, 3]) await mkdir(join(dirname(integration.path), `worker-${suffix}`), { recursive: true });
    const workerBranch = `graph/copy/xiu-fu-deng-lu-wen-ti-${lastGraph.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}/worker`;
    // Now that the names are taken, the worker is given work.
    phase = 'second';
    const message = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Give the last worker something to do.', requestId: 'branch-worker' }),
    });
    expect(message.status).toBe(200);
    await expect.poll(() => master.results.get('send-worker'), { timeout: 120_000, interval: 250 }).toBeTruthy();
    await expect.poll(async () => {
      const row = db.prepare('SELECT path,branch FROM worktrees WHERE task_id=? AND node_id=?').get(lastGraph, 'worker') as { path: string; branch: string } | undefined;
      return row?.branch;
    }, { timeout: 120_000, interval: 250 }).toBe(workerBranch);
    const worker = db.prepare('SELECT path,branch FROM worktrees WHERE task_id=? AND node_id=?').get(lastGraph, 'worker') as { path: string; branch: string };
    expect(basename(worker.path)).toBe('worker-4');
    expect(await git(worker.path, ['branch', '--show-current'])).toBe(workerBranch);
    expect(await readFile(join(occupied, 'retained.txt'), 'utf8')).toBe('do not overwrite');
  } finally { db.close(); }

  // The repository the user works in is still on the branch they chose.
  expect(await git(project, ['branch', '--show-current'])).toBe('feature/current');
  await daemon.close();
  await master.close();
  await node.close();
  await rm(root, { recursive: true, force: true });
}, 300_000);
