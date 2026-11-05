import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { DATA, canonical, readable, rows, scriptedProvider, waitFor, type ChatBody, type Step } from './go-module-operation.fixture.ts';

interface ModuleOperationRow { id: string; delivery_id: string; state: string; error: string | null }

/** One operation as `graph_inspect` really answers it. */
interface OperationAnswer {
  id: string;
  module_id: string;
  state: string;
  error: string | null;
  result: {
    outputs: {
      result: {
        passed: boolean;
        code: number | null;
        record: string;
        stdout: string;
        outputFiles: { stdout: { path: string }; stderr: { path: string } };
      };
    };
  };
}

/**
 * One delivery, several attempts, and the directory each of them is entitled to.
 *
 * A module operation that gives its attempt back (here: the source execution has
 * not integrated yet) is dispatched again under the same operation id. The
 * attempts are not the same run: each opens its own streams, may be killed and
 * may leave a record, and none of that belongs to the attempt after it, so they
 * cannot share a directory. Sharing one ended a real delivery for good
 * (task 288f801c, operation 1cfeb560):
 *
 *   open <state>/module-operations/<id>/stdout.log: file exists
 *
 * The proof is a real daemon, a real graph and a real Git project: the node
 * submits and keeps its turn open, the module is handed the value in that window
 * and gives its first attempt back, the source integrates, and the same
 * operation runs for real - with every attempt's evidence still readable.
 */

/**
 * The node model: it writes, submits, and then keeps talking.
 *
 * The turn after the submit is the window this test needs: the delivery exists
 * and the source execution is still running. The model is answered only when the
 * test releases it, after the module gave its first attempt back.
 */
const git = async (cwd: string, args: string[]) => {
  const result = await promisify(execFile)('git', args, { cwd });
  return result.stdout;
};

async function nodeProvider(releaseHold: () => Promise<void>) {
  const turns: ChatBody[] = [];
  let held = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    turns.push(body);
    const send = (id: string, name: string, args: unknown) => {
      const call = { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    if (turns.length === 1) {
      send('write', 'write_file', { path: 'feature.txt', content: 'done\n' });
      return;
    }
    if (turns.length === 2) {
      send('submit', 'submit', { outputs: { out: { enable: true, value: { marker: 'go' } } } });
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

test('the attempts of one operation each run in their own directory and leave the earlier ones readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-operation-scratch-'));
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
    name: 'Operation scratch isolation',
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

  // The node's open turn is released by the observation that the module gave
  // its first attempt back: the overlap is built, not hoped for.
  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => { release = resolve; });
  const node = await nodeProvider(async () => { await released; });

  const graphs: string[] = [];
  const graphIdOf = () => graphs[0] ?? '';
  /** The module operations of this graph, as the daemon really stored them. */
  const operations = () => rows<ModuleOperationRow>(root,
    'SELECT id,delivery_id,state,error FROM kernel_module_operations WHERE task_id=?', graphIdOf());
  /** The directory of one operation, and the attempts inside it. */
  const operationRoot = (operationId: string) => join(root, 'state', 'module-operations', operationId);
  const attemptsOf = async (operationId: string) => {
    const entries = await readdir(operationRoot(operationId), { withFileTypes: true }).catch(() => []);
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  };
  /** What one attempt left on disk, as bytes: identity, not meaning. */
  const attemptFiles = async (operationId: string, attempt: string) => {
    const directory = join(operationRoot(operationId), attempt);
    const names = (await readdir(directory)).sort();
    return {
      names,
      stdout: await readFile(join(directory, 'stdout.log'), 'utf8'),
      stderr: await readFile(join(directory, 'stderr.log'), 'utf8'),
    };
  };

  const operationId = { id: '' };
  /** Every attempt that existed before the source integrated, and what it held. */
  const early = new Map<string, { names: string[]; stdout: string; stderr: string }>();

  const master = await scriptedProvider(() => {
    const graphId = graphIdOf();
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } },
      { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'worker', input: 'job', value: { marker: 'go' } } },
      {
        // Inside the window: the operation exists, has given its attempt back,
        // and every attempt so far has opened its streams. Read them now, while
        // nothing has run yet.
        id: 'early-attempts', name: 'graph_inspect', args: { graphId, query: 'operations' },
        before: async () => {
          await waitFor(() => (operations().length > 0 && node.held() === 1 && operations()[0]!.state === 'prepared' ? ''
            : `operations=${JSON.stringify(operations())} held=${node.held()}`), 180_000);
          operationId.id = operations()[0]!.id;
          // The first attempt opens its streams before it crosses the boundary,
          // so they are already there - but give the daemon the moment it needs.
          let attempts: string[] = [];
          await waitFor(async () => {
            attempts = await attemptsOf(operationId.id);
            if (attempts.length > 0) return '';
            const entries = await readdir(operationRoot(operationId.id)).catch(() => [] as string[]);
            return entries.length > 0
              ? `expected attempt #1 of operation ${operationId.id} to run in a directory of its own; got: `
                + `${operationRoot(operationId.id)} whose entries are ${JSON.stringify(entries)}`
              : `attempts=${JSON.stringify(entries)}`;
          }, 60_000);
          for (const attempt of attempts) early.set(attempt, await attemptFiles(operationId.id, attempt));
        },
      },
      {
        // The same delivery retried after the source integrated: it settles.
        id: 'operations', name: 'graph_inspect', args: { graphId, query: 'operations' },
        before: async () => {
          release();
          await waitFor(() => {
            const found = operations();
            if (found.length === 1 && found[0]!.state === 'settled') return '';
            if (found.some(row => (row.error ?? '').includes('file exists'))) {
              throw new Error(`the retry collided with the attempt before it: ${JSON.stringify(found)}`);
            }
            return `operations=${JSON.stringify(found)}`;
          }, 120_000);
        },
      },
      { id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'scratch' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { scratch: { secretRef: 'GRAPH_SCRATCH_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'sender', provider: 'graph-node-sender', modelId: 'sender-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_SCRATCH_KEY: 'scratch-synthetic' }, extraArgs: ['--execute'] });
    const started = await daemon.request('/api/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the check module on the work.', requestId: 'scratch-begin' }),
    });
    expect(started.status).toBe(200);

    await expect.poll(() => master.results.has('summary') || master.failures.length > 0, { timeout: 240_000, interval: 250 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const after = JSON.parse(master.results.get('operations')!) as OperationAnswer[];
    // The retry was a second attempt of the same operation, not a new operation.
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(operationId.id);
    expect(after[0]!.state).toBe('settled');
    expect(after[0]!.error).toBeNull();
    const output = after[0]!.result.outputs.result;
    expect(output).toMatchObject({ passed: true, code: 0 });

    // Every attempt that already existed before the source integrated is still
    // there, and still holds exactly what it held: the attempt that ran did not
    // write over them and did not clear them to make room.
    const attempts = await attemptsOf(operationId.id);
    expect([...early.keys()].sort(), 'the attempt before the retry left no streams to compare').not.toEqual([]);
    for (const [attempt, before] of early) {
      expect(before.names, `attempt ${attempt} opened no streams`).toContain('stdout.log');
      expect(before.names).toContain('stderr.log');
      expect(attempts, `attempt ${attempt} is gone after the retry`).toContain(attempt);
      const now = await attemptFiles(operationId.id, attempt);
      // Nothing it had was removed or overwritten; an attempt that never settled
      // has no record of its own.
      for (const name of before.names) expect(now.names, `attempt ${attempt} lost ${name}`).toContain(name);
      expect(now.stdout).toBe(before.stdout);
      expect(now.stderr).toBe(before.stderr);
      expect(now.names).not.toContain('result.json');
    }

    // The attempt that ran is one more directory of its own, and it holds the
    // command's streams and its own record.
    const settledRecord = readable(output.record);
    const settledAttempt = basename(dirname(settledRecord));
    expect(early.has(settledAttempt), `the record was written into attempt ${settledAttempt}, which ran nothing`).toBe(false);
    expect(attempts).toContain(settledAttempt);
    expect(canonical(settledRecord)).toBe(canonical(join(operationRoot(operationId.id), settledAttempt, 'result.json')));
    const ran = await attemptFiles(operationId.id, settledAttempt);
    expect(ran.names, 'the attempt that ran left no record').toContain('result.json');
    expect(ran.names).toContain('stdout.log');
    expect(ran.names).toContain('stderr.log');
    expect(ran.stdout).toBe('module check ran\n');
    expect(canonical(readable(output.outputFiles.stdout.path))).toBe(canonical(join(operationRoot(operationId.id), settledAttempt, 'stdout.log')));

    const record = JSON.parse(await readFile(settledRecord, 'utf8')) as { operationId: string; code: number | null; stdout: string };
    expect(record).toMatchObject({ operationId: operationId.id, code: 0, stdout: 'module check ran\n' });
  } finally {
    release();
    await daemon?.close(); await master.close(); await node.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
