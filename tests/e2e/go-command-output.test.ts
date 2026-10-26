import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What a command actually printed.
 *
 * A check that prints thirty megabytes does not fit in a result message, and
 * it does not have to: the graph keeps the whole stream in a file and publishes
 * a bounded view of it. What matters is that the bytes are not lost - the file
 * holds every one of them, the digest says which ones, and a restart does not
 * run the command again or lose the file.
 *
 * The proof is a real daemon and a real graph: the master Agent creates a
 * graph whose module is a public workspace command, delivers into it and
 * reads the settled operation back.
 */

/** The bytes the command prints, plus the markers at the end of each stream. */
const BYTES = 32 * 1024 * 1024 + 123;
const SCRIPT = `process.stdout.write(Buffer.alloc(${BYTES},120));process.stdout.write('FINAL-OUTPUT');process.stderr.write('FINAL-ERROR');`;

const DEFINITION = {
  schemaVersion: 2,
  name: 'Output preservation',
  protocols: { data: { type: 'object' } },
  nodes: {},
  modules: {
    check: {
      type: 'operation', trigger: 'each',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: {
        action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result',
        args: ['-e', SCRIPT],
      },
    },
  },
  edges: {}, inputs: {}, outputs: {},
};

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall {
  id: string; name: string; args: unknown;
  /** Ask again until the answer says what the call was waiting for. */
  until?: (results: Map<string, string>) => boolean;
}

/** The master Agent. It plays the plan in order and records what every call answered. */
async function masterProvider(plan: (graphId: string) => MasterCall[]) {
  const results = new Map<string, string>();
  const repeats = new Map<string, number>();
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
    const next = plan(graphId).find(call => !spoken.has(call.id) || (call.until && !call.until(results)));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The command ran.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const repeat = repeats.get(next.id) ?? 0;
    const id = repeat === 0 ? next.id : `${next.id}-${repeat}`;
    if (next.until && !next.until(results)) repeats.set(next.id, repeat + 1);
    served.set(id, next.id);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
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

interface OperationOutput {
  passed: boolean;
  stdout: string;
  stderr: string;
  outputFiles: { stdout: { path: string; bytes: number; digest: string }; stderr: { path: string; bytes: number; digest: string } };
}

test('a public graph command keeps every byte beyond its inline view and reuses the settled file after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-command-output-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The first turn creates the graph and runs the command; the second turn
  // reads the same operation back after the restart.
  let phase: 'first' | 'second' = 'first';
  const master = await masterProvider(graphId => phase === 'first' ? [
    { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: DEFINITION } },
    { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'check', input: 'job', value: {} } },
    // The request of the operation already carries the script, so the settled
    // marker is the published output, not the command text.
    { id: 'operations', name: 'graph_inspect', args: { graphId, query: 'operations' },
      until: results => (results.get('operations') ?? '').includes('"passed"') },
  ] : [
    { id: 'operations-again', name: 'graph_inspect', args: { graphId, query: 'operations' },
      until: results => (results.get('operations-again') ?? '').includes('"passed"') },
  ]);
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { output: { secretRef: 'GRAPH_OUTPUT_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
      baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'output' }] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_OUTPUT_KEY: 'output-synthetic' }, extraArgs: ['--execute'] });
  const created = await daemon.request('/api/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the public check.', requestId: 'output-begin' }),
  });
  expect(created.status).toBe(200);
  const createdConversation = (await created.json() as { conversationId: string }).conversationId;
  await expect.poll(() => master.results.get('operations'), { timeout: 180_000, interval: 500 }).toContain('"passed"');

  const operations = JSON.parse(master.results.get('operations')!) as { state: string; result?: { outputs: { result: OperationOutput } } }[];
  expect(operations).toHaveLength(1);
  expect(operations[0]!.state).toBe('settled');
  const output = operations[0]!.result!.outputs.result;
  expect(output.passed).toBe(true);

  // The published view is bounded: the whole stream does not travel inline.
  expect(output.stdout.length).toBeLessThanOrEqual(32_768);

  // The whole stream is in the file, and the digest says which bytes.
  const stdout = await readFile(output.outputFiles.stdout.path);
  expect(stdout.length).toBe(BYTES + 'FINAL-OUTPUT'.length);
  expect(stdout.subarray(-'FINAL-OUTPUT'.length).toString()).toBe('FINAL-OUTPUT');
  expect(output.outputFiles.stdout).toMatchObject({
    bytes: stdout.length,
    digest: createHash('sha256').update(stdout).digest('hex'),
  });
  expect(await readFile(output.outputFiles.stderr.path, 'utf8')).toBe('FINAL-ERROR');

  // A restart does not run the command again, and the file is still there.
  await daemon.close();
  phase = 'second';
  const second = await launchCli(root, { configPath, env: { GRAPH_OUTPUT_KEY: 'output-synthetic' }, extraArgs: ['--execute'] });
  const message = await second.request(`/api/conversations/${createdConversation}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Read the settled operation again.', requestId: 'output-again' }),
  });
  expect(message.status).toBe(200);
  await expect.poll(() => master.results.get('operations-again'), { timeout: 120_000, interval: 500 }).toContain('"passed"');
  // The operation is the same operation: it was not run a second time.
  const again = JSON.parse(master.results.get('operations-again')!) as { state: string; result?: { outputs: { result: OperationOutput } } }[];
  expect(again).toEqual(operations);
  expect(again[0]!.result!.outputs.result.outputFiles.stdout.path).toBe(output.outputFiles.stdout.path);
  const restoredBytes = await readFile(output.outputFiles.stdout.path);
  expect(restoredBytes.length).toBe(stdout.length);
  expect(createHash('sha256').update(restoredBytes).digest('hex')).toBe(output.outputFiles.stdout.digest);
  await second.close();

  await master.close();
  await rm(root, { recursive: true, force: true });
}, 300_000);
