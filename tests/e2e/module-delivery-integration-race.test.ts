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
 * A module handed a node's output while that node is still talking.
 *
 * A submission lands its deliveries at submit time, so a module an edge feeds
 * can be asked to run before the source execution settled - and a
 * workspace.command on the integration worktree must not run code the
 * integration branch does not hold yet. That moment is a wait, not a failure:
 * the delivery stays pending, the module node keeps working, and the operation
 * produces its result once the source really integrated. A manual cancel and
 * resend is not part of the answer.
 *
 * The proof is a real daemon, a real graph and a real Git project: the node
 * submits and its own turn stays open, the module is handed the value inside
 * that window, and afterwards the module's own result.json and its published
 * output exist while nothing recorded a module failure.
 */

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => {
  const result = await run('git', args, { cwd });
  return result.stdout;
};

const DATA = { protocol: 'data' };

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
interface Step { id: string; name: string; args: unknown; before?: () => Promise<void> }
interface ModuleOperationRow { id: string; delivery_id: string; state: string; error: string | null }
interface InboxRow { delivery_id: string; processed: number }

/** One operation row as the graph_inspect operations query really answers it. */
interface OperationAnswer {
  id: string;
  module_id: string;
  state: string;
  error: string | null;
  result: {
    outputs: {
      result: {
        passed: boolean; code: number; record: string;
        outputFiles: { stdout: { path: string } };
      };
    };
  };
}

/** One scripted model: it plays the plan in order and records what every call answered. */
async function scriptedProvider(plan: () => Step[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const failures: string[] = [];
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
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Nothing left to say.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      // A step that could not reach its state ends the turn: the test reads the
      // reason instead of waiting for a plan that can no longer run.
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results, failures,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * The node model: it writes, submits, and then keeps talking.
 *
 * The turn after the submit is the window this test needs. It is answered only
 * after the module has really been handed the submitted value, so the delivery
 * and the source execution provably overlap: the node had not integrated while
 * the module was waiting for it.
 */
async function nodeProvider(releaseHold: () => Promise<void>) {
  const turns: ChatBody[] = [];
  let held = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the node's turn.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    turns.push(body);
    if (turns.length === 1) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'done\n' }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    if (turns.length === 2) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { marker: 'go' } } } }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    if (JSON.stringify(body.messages ?? []).includes('"name":"submit"')) {
      held += 1;
      await releaseHold();
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The work is done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    turns, held: () => held,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
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

/** A path the daemon reported, readable from this process. */
function readable(path: string): string {
  return path.startsWith('/private/') ? path.replace(/^\/private/, '') : path;
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

test('a module handed a node output before that node integrated waits and still produces its result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-module-race-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'project\n');
  // The module's command: only a tree the integration holds can run it.
  await writeFile(join(project, 'test', 'pass.js'), 'console.log("module check ran");\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md', 'test/pass.js'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await git(project, args);
  }

  const definition = {
    schemaVersion: 2,
    name: 'Module delivery race',
    protocols: { data: { type: 'object' } },
    nodes: {
      worker: {
        recipe: 'coder@1', model: 'sender', task: 'Write the feature and submit it',
        inputs: { job: DATA }, outputs: { out: DATA }, submission: {},
      },
    },
    modules: {
      check: {
        type: 'operation', trigger: 'each',
        inputs: { job: DATA }, outputs: { result: DATA },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/pass.js'] },
      },
    },
    edges: { verify: { from: 'worker.out', to: 'check.job', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'data' } },
  };

  // The node's open turn is released by the observation that the module was
  // really handed the value: the overlap is built, not hoped for.
  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => { release = resolve; });
  const node = await nodeProvider(async () => { await released; });

  const graphs: string[] = [];
  const graphIdOf = () => graphs[0] ?? '';
  /** The module operations of this graph, as the daemon really stored them. */
  const operations = () => rows<ModuleOperationRow>(root,
    'SELECT id,delivery_id,state,error FROM kernel_module_operations WHERE task_id=?', graphIdOf());
  /** Every delivery of this graph and whether the module handled it. */
  const inbox = () => rows<InboxRow>(root,
    'SELECT delivery_id,processed FROM kernel_module_inbox WHERE task_id=?', graphIdOf());

  const master = await scriptedProvider(() => {
    const graphId = graphIdOf();
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } },
      { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { marker: 'go' } } },
      {
        // The window: the node has submitted and is still talking, and the
        // module has already been handed the value.
        id: 'operations-in-window', name: 'graph_inspect', args: { graphId, query: 'operations' },
        before: async () => {
          await waitFor(() => (operations().length > 0 && node.held() === 1 ? ''
            : `operations=${JSON.stringify(operations())} held=${node.held()}`), 180_000);
        },
      },
      {
        // The module is no longer waiting: the delivery is off the inbox and the
        // operation settled on its own, with nothing cancelled and nothing resent.
        id: 'operations', name: 'graph_inspect', args: { graphId, query: 'operations' },
        before: async () => {
          release();
          await waitFor(() => {
            const rowsNow = operations();
            if (rowsNow.every(row => row.state === 'settled') && inbox().every(row => row.processed === 1)) return '';
            // A wait that turned into a hard failure is the behaviour this test
            // exists to rule out: it is reported now, not after a timeout.
            if (rowsNow.some(row => row.state === 'failed')) {
              throw new Error(`the module failed instead of waiting for the source: ${JSON.stringify(rowsNow)}`);
            }
            return `inbox=${JSON.stringify(inbox())} operations=${JSON.stringify(rowsNow)}`;
          }, 120_000);
        },
      },
      { id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' } },
      { id: 'nodes', name: 'graph_inspect', args: { graphId, query: 'nodes' } },
      { id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'race' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { race: { secretRef: 'GRAPH_RACE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RACE_KEY: 'race-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the check module on the work.', requestId: 'race-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    // The plan either reached its last step or stopped on the fact this test
    // rules out; a graph that never settles is a failure, not a slow test.
    await expect.poll(() => master.results.has('summary') || master.failures.length > 0, { timeout: 180_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // Inside the window the module was asked for the value the source had just
    // submitted, and it had not crossed its send boundary yet: nothing was
    // recorded against it for the overlap.
    const inWindow = JSON.parse(master.results.get('operations-in-window')!) as OperationAnswer[];
    expect(inWindow.map(row => [row.module_id, row.state, row.error])).toEqual([['check', 'prepared', null]]);

    // Afterwards the same operation settled on its own: no cancel, no resend,
    // no second operation for the delivery.
    const after = JSON.parse(master.results.get('operations')!) as OperationAnswer[];
    expect(after.map(row => [row.module_id, row.state, row.error])).toEqual([['check', 'settled', null]]);
    expect(after[0]!.result.outputs.result).toMatchObject({ passed: true, code: 0 });
    expect(operations().map(row => row.state)).toEqual(['settled']);
    expect(inbox().map(row => row.processed)).toEqual([1]);
    // One delivery, one operation: the value was not handed to the module twice.
    expect(operations()).toHaveLength(1);
    expect(rows<{ n: number }>(root, 'SELECT COUNT(*) AS n FROM kernel_deliveries WHERE task_id=? AND to_endpoint=?', graphIdOf(), 'check.job'))
      .toEqual([{ n: 1 }]);

    // The module produced its own record, and it says its command really ran.
    const output = after[0]!.result.outputs.result;
    const record = JSON.parse(await readFile(readable(output.record), 'utf8')) as
      { operationId: string; code: number; stdout: string; commit: string | null; verifiedCommit: string | null };
    expect(record).toMatchObject({ operationId: after[0]!.id, code: 0, stdout: 'module check ran\n' });
    // It ran in a clean tree, on the commit the integration holds.
    expect(record.verifiedCommit).toBeTruthy();
    expect(record.verifiedCommit).toBe(record.commit);
    // The evidence belongs to the attempt that really ran: the stream log of the
    // attempt that never crossed its boundary was cleared, not merged into it.
    expect(await readFile(readable(output.outputFiles.stdout.path), 'utf8')).toBe('module check ran\n');

    // The result reached the graph's own output.
    const results = JSON.parse(master.results.get('results')!) as { output_name: string; value: { passed: boolean; operationId: string } }[];
    expect(results.map(row => row.output_name)).toEqual(['result']);
    expect(results[0]!.value).toMatchObject({ passed: true, operationId: after[0]!.id });

    // Nothing was parked for a manual cancel: the module is not paused, the
    // worker succeeded, and no module failure was recorded for the delivery.
    expect(rows<{ paused: number }>(root, 'SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?', graphIdOf(), 'check'))
      .toEqual([]);
    const nodes = JSON.parse(master.results.get('nodes')!) as { id: string; status?: string }[];
    expect(nodes.map(row => [row.id, row.status])).toEqual([['worker', 'succeeded']]);
    const events = await request(`/api/tasks/${graphIdOf()}/events`);
    expect((events.body as { type: string }[]).filter(event => event.type === 'graph.module.failed')).toEqual([]);
    // The graph moved on instead of staying parked on the delivery.
    expect((JSON.parse(master.results.get('summary')!) as { phase: string }).phase).toBe('idle');
  } finally {
    release();
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
