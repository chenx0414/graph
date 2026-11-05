import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A check binds the attempt that judged it, never the one that did not.
 *
 * The acceptance used to read the module's newest operation and nothing else, so
 * one interrupted attempt outranked the settled evidence of the same module for
 * good: the item reported "Host check is uncertain" while a real check had run
 * and passed a minute earlier. The rule is now the one an operator would use -
 * bind the newest attempt that reached a verdict - and an attempt that settled
 * without an exit code is not evidence either, it is the absence of it.
 *
 * The proof is a real daemon and one real module that runs three times: a pass,
 * a command its own supervisor killed (no exit code), and an attempt interrupted
 * by stopping the graph. Only the first judged anything.
 */

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run('git', args, { cwd })).stdout;

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
interface Step { id: string; name: string; args: unknown }
interface OperationRow { id: string; state: string; result: string | null }

/** One scripted master: the test asks for each step with a message of its own. */
async function masterModel(plan: (spoken: Set<string>, results: Map<string, string>, userText: string) => Step | undefined) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const messages = body.messages ?? [];
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set(messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const say = (delta: unknown, finish: string | null) => response.write(frame({
      id: 'r', choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 5 },
    }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let next: Step | undefined;
    try {
      next = (body.tools ?? []).length ? plan(spoken, results, userText) : undefined;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      next = undefined;
    }
    if (!next) {
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
    failures,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Rows the daemon really has in its own state database. */
function rows<T>(root: string, query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(query).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

/** One stored result, following the digest a large one travels by. */
function storedResult(root: string, stored: string | null): Record<string, any> {
  const text = stored ?? '';
  const prefix = 'graph-content:sha256:';
  if (!text.startsWith(prefix)) return JSON.parse(text) as Record<string, any>;
  const body = rows<{ body: string }>(root, 'SELECT body FROM kernel_content WHERE digest=?', text.slice(prefix.length))[0]?.body ?? '';
  return JSON.parse(body) as Record<string, any>;
}

/** The verdict one operation published, as the module's output really carries it. */
function verdictOf(root: string, operation: OperationRow): { verdict?: string; code?: number | null } {
  const settled = storedResult(root, operation.result);
  const outputs = (settled.outputs ?? {}) as Record<string, Record<string, any>>;
  const output = Object.values(outputs)[0] ?? {};
  return { verdict: output.verdict, code: output.code };
}

test('an acceptance item binds the attempt that judged it, not an interrupted or unjudged one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-acceptance-binding-'));
  const tree = join(root, 'project');
  await mkdir(join(tree, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The module reads its mode from files this case writes: a plain run passes, a
  // "kill" run dies without an exit code, a "wait" run is still running when the
  // graph is stopped. Nothing here waits for the clock.
  const modeFile = join(root, 'check-mode');
  const gateFile = join(root, 'check-gate');
  await writeFile(join(tree, 'test', 'check.js'), [
    "const fs = require('fs');",
    `const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() : '';`,
    "if (mode === 'kill') process.kill(process.pid, 'SIGKILL');",
    `if (mode === 'wait') { while (!fs.existsSync(${JSON.stringify(gateFile)})) {} }`,
    "console.log('module check ran');",
    '',
  ].join('\n'));
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'test/check.js'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await git(tree, args);
  }

  const definition = {
    schemaVersion: 2,
    name: 'Acceptance binding',
    protocols: { data: { type: 'object' } },
    nodes: {},
    modules: {
      check: {
        type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/check.js'], timeoutMs: 60000 },
      },
    },
    edges: {}, inputs: {}, outputs: { result: { from: 'check.result', protocol: 'data' } },
    acceptance: [{ id: 'host-check', description: 'The check module judged the work', kind: 'check', module: 'check' }],
  };

  const graphIdOf = (results: Map<string, string>) => {
    const created = results.get('create-graph');
    if (!created) return '';
    return String((JSON.parse(created) as { graphId?: string }).graphId ?? '');
  };

  const master = await masterModel((spoken, results, userText) => {
    const graphId = graphIdOf(results);
    if (userText.includes('P5C_CREATE') && !spoken.has('create-graph')) {
      return { id: 'create-graph', name: 'graph_create', args: { requestId: 'create-graph', definition } };
    }
    if (!graphId) return undefined;
    const sends: [string, string][] = [['P5C_SEND_ONE', 'send-one'], ['P5C_SEND_TWO', 'send-two'], ['P5C_SEND_THREE', 'send-three']];
    for (const [marker, id] of sends) {
      if (userText.includes(marker) && !spoken.has(id)) {
        return { id, name: 'graph_send', args: { graphId, nodeId: 'check', input: 'job', value: { n: 1 } } };
      }
    }
    const reads: [string, string][] = [
      ['P5C_READ_FIRST', 'read-first'], ['P5C_READ_SECOND', 'read-second'], ['P5C_READ_THIRD', 'read-third'],
    ];
    for (const [marker, id] of reads) {
      if (userText.includes(marker) && !spoken.has(id)) return { id, name: 'graph_inspect', args: { graphId, query: 'acceptance' } };
    }
    if (userText.includes('P5C_STOP') && !spoken.has('stop')) {
      return { id: 'stop', name: 'graph_control', args: { graphId, action: 'stop', requestId: 'stop-graph' } };
    }
    return undefined;
  });

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'binding' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: tree }],
      credentials: { binding: { secretRef: 'GRAPH_BINDING_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_BINDING_KEY: 'binding-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
    };
    let graphId = '';
    const conversation = async (text: string) => {
      const sent = await request(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text, requestId: text }) });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    };
    const acceptance = async (marker: string) => {
      await conversation(marker);
      const id = marker.replace('P5C_READ_', '').toLowerCase();
      await expect.poll(() => master.results.has(`read-${id}`), { timeout: 120_000, interval: 250 }).toBeTruthy();
      return JSON.parse(master.results.get(`read-${id}`)!) as {
        items: { id: string; status: string; reason: string; source?: { id: string } }[];
      };
    };
    const operations = () => rows<OperationRow>(root, 'SELECT id,state,result FROM kernel_module_operations WHERE task_id=? ORDER BY rowid', graphId);

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'P5C_CREATE: build the check graph', requestId: 'binding-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const conversationId = started.body.conversationId as string;
    await expect.poll(() => graphIdOf(master.results), { timeout: 120_000, interval: 250 }).not.toBe('');
    graphId = graphIdOf(master.results);

    // The first attempt runs and passes: it is the evidence this item keeps.
    await conversation('P5C_SEND_ONE: run the check');
    await expect.poll(() => {
      const current = operations();
      return current.length === 1 && current[0]!.state === 'settled' ? '' : `operations=${JSON.stringify(current.map(row => row.state))}`;
    }, { timeout: 120_000, interval: 100 }).toBe('');
    const passed = operations()[0]!;
    expect(verdictOf(root, passed).verdict).toBe('passed');
    const first = await acceptance('P5C_READ_FIRST');
    expect(first.items.find(item => item.id === 'host-check')).toMatchObject({ status: 'passed', source: { id: passed.id } });

    // The second attempt is killed by its own supervisor, so it published no exit
    // code: the item must not bind it, whatever it says about the work.
    await writeFile(modeFile, 'kill');
    await conversation('P5C_SEND_TWO: run the check again');
    await expect.poll(() => {
      const current = operations();
      return current.length === 2 && current[1]!.state === 'settled' ? '' : `operations=${JSON.stringify(current.map(row => row.state))}`;
    }, { timeout: 120_000, interval: 100 }).toBe('');
    const killed = operations()[1]!;
    expect(verdictOf(root, killed)).toMatchObject({ verdict: 'unknown', code: null });
    const second = await acceptance('P5C_READ_SECOND');
    expect(second.items.find(item => item.id === 'host-check')).toMatchObject({ status: 'passed', source: { id: passed.id } });

    // The third attempt is interrupted after it crossed its send boundary, so it
    // ends uncertain - the state that used to pin the item forever.
    await writeFile(modeFile, 'wait');
    await conversation('P5C_SEND_THREE: run the check a third time');
    await expect.poll(() => {
      const current = operations();
      return current.length === 3 && current[2]!.state === 'dispatched' ? '' : `operations=${JSON.stringify(current.map(row => row.state))}`;
    }, { timeout: 120_000, interval: 100 }).toBe('');
    await conversation('P5C_STOP: stop the graph');
    await expect.poll(() => operations()[2]?.state ?? '', { timeout: 60_000, interval: 100 }).toBe('uncertain');
    const third = await acceptance('P5C_READ_THIRD');
    const item = third.items.find(candidate => candidate.id === 'host-check')!;
    // The newest attempt is not the evidence: the settled judgment is.
    expect(operations()[2]!.id).not.toBe(passed.id);
    expect(item).toMatchObject({ status: 'passed', source: { id: passed.id } });
    expect(item.reason).toBe('Host check passed');
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
