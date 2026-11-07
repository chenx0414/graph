import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What the host records when nothing judged an operation.
 *
 * Two real module operations end without a verdict. One is handed its value
 * before the source execution integrated, so it cannot run yet; the other is a
 * command its own timeout killed, so it has no exit code. Neither is a failure -
 * nothing ran in the first and nothing finished in the second - yet both used to
 * be recorded as `failed`, which turned "wait a moment" and "no conclusion" into
 * "the work is bad" and needed a human to cancel it.
 *
 * Each one now says what happened, once, in an event a reader can group on:
 * `graph.operation.unjudged` with the reason. What follows is the other half of
 * the contract: an operation that only had to wait goes on to settle by itself,
 * and that progress is an event about the same operation.
 */

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run('git', args, { cwd })).stdout;
const DATA = { protocol: 'data' };
const PROTOCOLS = { data: { type: 'object' } };

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
interface Step { id: string; name: string; args: unknown }
interface OperationRow { id: string; delivery_id: string; module_id: string; state: string; worker_active: number }
interface EventRow { type: string; data: Record<string, any> }

/** One scripted model: it answers with the next call of its plan and remembers the results. */
async function model(plan: (body: ChatBody) => Step | undefined | Promise<Step | undefined>, onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const say = (delta: unknown, finish: string | null) => response.write(frame({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const next = (body.tools ?? []).length ? await plan(body) : undefined;
    if (!next || spoken.has(next.id)) {
      say({ role: 'assistant', content: 'Noted.' }, 'stop');
    } else {
      say({ role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
        function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null);
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: {} }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    results,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * The node model: it writes, submits, and then keeps talking until it is released.
 *
 * The turn after the submit is the window this case needs: it is answered only
 * once the module has really been handed the submitted value, so the delivery
 * and the source execution provably overlap.
 */
async function worker(hold: () => Promise<void>) {
  let turns = 0;
  return model(async body => {
    const turn = (turns += 1);
    if (turn === 1) return { id: 'write', name: 'write_file', args: { path: 'feature.txt', content: 'done\n' } };
    if (turn === 2) return { id: 'submit', name: 'submit', args: { outputs: { out: { enable: true, value: { marker: 'go' } } } } };
    if (JSON.stringify(body.messages ?? []).includes('"name":"submit"')) await hold();
    return undefined;
  });
}

/** Rows one graph really has in its own state database. */
function rows<T>(root: string, query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    return db.prepare(query).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

/** Polls a fact the product settles on its own, naming what it saw when it never settles. */
async function waitFor(read: () => string, timeout: number) {
  const deadline = Date.now() + timeout;
  let seen = '';
  while (Date.now() < deadline) {
    seen = read();
    if (seen === '') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`never settled: ${seen}`);
}

/** Polls the graph's event stream for one statement, with the half minute the contract allows. */
async function eventOf(events: () => Promise<EventRow[]>, match: (event: EventRow) => boolean, expected: string) {
  const deadline = Date.now() + 30_000;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    const listed = await events();
    const found = listed.find(match);
    if (found) return found;
    seen = listed.map(event => `${event.type}:${JSON.stringify(event.data)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`expected ${expected} within 30s; saw ${JSON.stringify(seen.slice(-6))}`);
}

/**
 * The record one operation published, read from the output it settled with.
 *
 * The file's directory is the broker's own layout - one directory per attempt -
 * and an operator reading the result should never have to know it. The published
 * output carries the path, so this asks the record rather than guessing where an
 * attempt put it.
 */
function publishedRecord(root: string, operationId: string): string {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  let stored = '';
  try {
    stored = ((db.prepare('SELECT result FROM kernel_module_operations WHERE id=?').get(operationId) as { result?: string } | undefined)?.result) ?? '';
  } finally {
    db.close();
  }
  // A large result travels by digest, so the body is fetched the way the daemon fetches it.
  let body = stored;
  const prefix = 'graph-content:sha256:';
  if (stored.startsWith(prefix)) {
    const content = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      body = ((content.prepare('SELECT body FROM kernel_content WHERE digest=?').get(stored.slice(prefix.length)) as { body?: string } | undefined)?.body) ?? '';
    } finally {
      content.close();
    }
  }
  const settled = body ? JSON.parse(body) as { outputs?: Record<string, { record?: string }> } : {};
  const record = Object.values(settled.outputs ?? {}).map(output => output?.record).find(found => typeof found === 'string');
  if (!record) throw new Error(`operation ${operationId} published no record path: ${stored || 'no stored result'}`);
  return record;
}

/** A project with a Git baseline and the scripts a module runs. */
async function project(root: string, scripts: Record<string, string>): Promise<string> {
  const tree = join(root, 'project');
  await mkdir(join(tree, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(tree, 'README.md'), 'project\n');
  for (const [path, source] of Object.entries(scripts)) await writeFile(join(tree, path), source);
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md', ...Object.keys(scripts)],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await git(tree, args);
  }
  return tree;
}

/** A real daemon driving real models against a real project. */
async function daemonFor(root: string, tree: string, models: { id: string; provider: string; baseUrl: string; }[]) {
  const configPath = join(root, 'graph.config.json');
  const entry = { api: 'openai-completions', maxTokens: 256, contextWindow: 32000, credentialId: 'verdict' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: tree }],
    credentials: { verdict: { secretRef: 'GRAPH_VERDICT_KEY' } },
    models: { entries: models.map(one => ({ ...entry, ...one, modelId: one.id + '-model' })) },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_VERDICT_KEY: 'verdict-synthetic' }, extraArgs: ['--execute'] });
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const events = async (graphId: string) => (await request(`/api/tasks/${graphId}/events?limit=500`)).body as EventRow[];
  return { daemon, request, events };
}

test('a module that cannot run yet says so instead of failing, and then settles on its own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-verdict-wait-'));
  const tree = await project(root, { 'test/pass.js': 'console.log("module check ran");\n' });
  const definition = {
    schemaVersion: 2,
    name: 'Operation verdict',
    protocols: PROTOCOLS,
    nodes: {
      worker: { recipe: 'coder@1', model: 'node', task: 'Write the feature and submit it', inputs: { job: DATA }, outputs: { out: DATA }, submission: {} },
    },
    modules: {
      check: {
        type: 'operation', trigger: 'each', inputs: { job: DATA }, outputs: { result: DATA },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/pass.js'] },
      },
    },
    edges: { verify: { from: 'worker.out', to: 'check.job', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'data' } },
  };

  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => { release = resolve; });
  const node = await worker(async () => { await released; });
  const graphs: string[] = [];
  const graphIdOf = () => graphs[0] ?? '';
  const operations = () => rows<OperationRow>(root, 'SELECT id,delivery_id,module_id,state,worker_active FROM kernel_module_operations WHERE task_id=?', graphIdOf());

  const master = await model(() => (
    graphs[0] ? { id: 'send', name: 'graph_send', args: { graphId: graphs[0], nodeId: 'worker', input: 'job', value: { marker: 'go' } } }
      : { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } }
  ), (id, content) => {
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (id === 'create' && found) graphs[0] = found[1]!;
  });

  const { daemon, request, events } = await daemonFor(root, tree, [{ id: 'main', provider: 'graph-master', baseUrl: master.baseUrl }, { id: 'node', provider: 'graph-node-sender', baseUrl: node.baseUrl }]);
  try {
    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the check module on the work.', requestId: 'verdict-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    // The module holds the value while its source still has its turn open, so it
    // could not cross its send boundary: the operation exists, judged nothing.
    await waitFor(() => (operations().length > 0 ? '' : 'the operation was never prepared'), 120_000);
    expect(operations().map(row => [row.module_id, row.state])).toEqual([['check', 'prepared']]);

    // Within half a minute the graph says why it is not advancing, instead of
    // leaving the delivery on the inbox silently.
    const waited = await eventOf(() => events(graphIdOf()), event =>
      event.type === 'graph.operation.unjudged' && event.data?.reasonCode === 'waiting_integration',
    'a graph.operation.unjudged event with reasonCode waiting_integration');
    expect(waited.data).toMatchObject({ moduleId: 'check', deliveryId: operations()[0]!.delivery_id, reasonCode: 'waiting_integration' });

    // The wait ended by itself: the source integrated, the same operation ran,
    // and the progress is an event about that same operation.
    release();
    await waitFor(() => {
      const current = operations();
      return current.length === 1 && current[0]!.state === 'settled' && current[0]!.worker_active === 0
        ? '' : `operations=${JSON.stringify(current)}`;
    }, 120_000);
    const everything = await events(graphIdOf());
    expect(everything.filter(event => event.type === 'graph.operation.settled').map(event => event.data.operationId))
      .toEqual([operations()[0]!.id]);
    // Nothing was judged badly for waiting, and nothing was judged twice.
    expect(everything.filter(event => event.type === 'graph.module.failed')).toEqual([]);
    expect(everything.filter(event => event.type === 'graph.operation.unjudged').map(event => event.data.reasonCode))
      .toEqual(['waiting_integration']);
    expect(rows<{ n: number }>(root, 'SELECT COUNT(*) AS n FROM kernel_deliveries WHERE task_id=? AND to_endpoint=?', graphIdOf(), 'check.job'))
      .toEqual([{ n: 1 }]);
    // The module really ran its command, in the attempt that settled.
    const record = JSON.parse(await readFile(publishedRecord(root, operations()[0]!.id), 'utf8'));
    expect(record).toMatchObject({ operationId: operations()[0]!.id, code: 0, stdout: 'module check ran\n' });
  } finally {
    release();
    await daemon.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('a command killed by its own timeout is recorded as unjudged, not as a failed check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-verdict-timeout-'));
  const tree = await project(root, { 'test/hang.js': 'setTimeout(() => {}, 120000);\n' });
  const definition = {
    schemaVersion: 2,
    name: 'Operation verdict timeout',
    protocols: PROTOCOLS,
    nodes: {},
    modules: {
      check: {
        type: 'operation', trigger: 'each', inputs: { job: DATA }, outputs: { result: DATA },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/hang.js'], timeoutMs: 2000 },
      },
    },
    edges: {}, inputs: {}, outputs: { result: { from: 'check.result', protocol: 'data' } },
  };

  const graphs: string[] = [];
  const graphIdOf = () => graphs[0] ?? '';
  const operations = () => rows<OperationRow>(root, 'SELECT id,delivery_id,module_id,state,worker_active FROM kernel_module_operations WHERE task_id=?', graphIdOf());

  const master = await model(() => (
    graphs[0] ? { id: 'send', name: 'graph_send', args: { graphId: graphs[0], nodeId: 'check', input: 'job', value: { marker: 'go' } } }
      : { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } }
  ), (id, content) => {
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (id === 'create' && found) graphs[0] = found[1]!;
  });

  const { daemon, request, events } = await daemonFor(root, tree, [{ id: 'main', provider: 'graph-master', baseUrl: master.baseUrl }]);
  try {
    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the hanging check.', requestId: 'verdict-timeout' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    // The command was killed by its own two-second budget, so it published no
    // exit code and nobody judged it.
    await waitFor(() => {
      const current = operations();
      return current.length === 1 && current[0]!.state === 'settled' && current[0]!.worker_active === 0
        ? '' : `operations=${JSON.stringify(current)}`;
    }, 120_000);
    const operation = operations()[0]!;
    const record = JSON.parse(await readFile(publishedRecord(root, operation.id), 'utf8'));
    expect(record.code).toBe(null);
    expect(record.stderr).toContain('it exceeded the 2000ms timeout');

    const unjudged = await eventOf(() => events(graphIdOf()), event =>
      event.type === 'graph.operation.unjudged' && event.data?.reasonCode === 'no_exit_code',
    'a graph.operation.unjudged event with reasonCode no_exit_code');
    expect(unjudged.data).toMatchObject({
      moduleId: 'check', deliveryId: operation.delivery_id, operationId: operation.id, reasonCode: 'no_exit_code',
    });
    // The row is settled, never failed: the command did run, it just said nothing.
    expect(rows<{ state: string }>(root, 'SELECT state FROM kernel_module_operations WHERE task_id=?', graphIdOf()))
      .toEqual([{ state: 'settled' }]);
    expect((await events(graphIdOf())).filter(event => event.type === 'graph.module.failed')).toEqual([]);
  } finally {
    await daemon.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
