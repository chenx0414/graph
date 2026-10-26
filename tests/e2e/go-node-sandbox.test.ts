import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A worker works in its own copy, and the access mode is the boundary.
 *
 * A node that runs under the standard access policy may only read its own
 * work copy and the roots it was granted: the host's own files - the state
 * directory, another project's secret, the verifier an evaluation keeps out of
 * sight - are not reachable from inside. The refusal has to be real in two
 * ways: the bytes never reach the model, and the call is recorded as the
 * failure it was, so the ledger does not say a worker read something it was
 * denied.
 *
 * The same file under the full access policy is readable, because the mode is
 * what decides. Both halves are proved here: a boundary that cannot be
 * crossed, and a policy that is actually in force.
 *
 * The proof is a real daemon, a real graph, a real worker and a real
 * provider: the worker's own request history is what is checked.
 */

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => { await run('git', args, { cwd }); };

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface Step { id: string; name: string; args: unknown }

/** A scripted model that plays its plan in order and records every tool result. */
async function scriptedProvider(plan: () => Step[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const requests: unknown[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
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
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The work is as expected.' }, finish_reason: 'stop' }],
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
    results,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const MARKER = 'HOST-ONLY-MARKER-9f2c';

/** Run one graph whose worker tries to read a file that lives outside it. */
async function readOutsideTheWorkCopy(access: 'standard' | 'full') {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-sandbox-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'project\n');
  // The host's own file: it lives outside the project, so it is outside the
  // worker's work copy too.
  const secret = join(root, 'host-secret.txt');
  await writeFile(secret, MARKER);
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await git(project, args);
  }

  const definition = {
    schemaVersion: 2,
    name: 'Sandboxed worker',
    protocols: { data: { type: 'object' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'sender', task: 'Report what the environment shows',
        access: { mode: access }, inputs: {}, outputs: {}, submission: {} },
    },
    modules: {},
    edges: {},
    acceptance: [],
  };

  const worker = await scriptedProvider(() => [
    { id: 'peek', name: 'read', args: { path: secret } },
  ]);
  const graphs: string[] = [];
  const master = await scriptedProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } },
      { id: 'chat', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Report what the environment shows' } },
      { id: 'nodes', name: 'graph_inspect', args: { graphId, query: 'nodes' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

  const configPath = join(root, 'graph.config.json');
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'sandbox' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { sandbox: { secretRef: 'GRAPH_SANDBOX_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...credential, id: 'sender', provider: 'graph-worker', modelId: 'worker-model', baseUrl: worker.baseUrl, contextWindow: 32000 },
    ] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_SANDBOX_KEY: 'sandbox-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Look around.', requestId: 'node-sandbox' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('nodes'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    // The worker really made the read.
    await expect.poll(() => worker.results.has('peek'), { timeout: 120_000, interval: 250 }).toBeTruthy();

    const stats = await (await daemon.request('/api/tool-stats')).json() as {
      stats: { tool: string; role?: string; calls: number; errors: number }[];
    };
    return {
      refusal: worker.results.get('peek')!,
      history: JSON.stringify([...worker.requests, ...master.requests]),
      stats: stats.stats,
    };
  } finally {
    await daemon.close();
    await master.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a worker under the standard access policy cannot read outside its own work copy, and the ledger records the refusal', async () => {
  const outcome = await readOutsideTheWorkCopy('standard');

  // The refusal is a refusal: the host's bytes never reached the model.
  expect(outcome.history, 'the host file reached the model').not.toContain(MARKER);
  expect(outcome.refusal).toMatch(/outside the workspace|not permitted|denied|not allowed/i);

  // The ledger says the call failed, for the worker.
  const reads = outcome.stats.filter(entry => entry.tool === 'read');
  expect(reads.length, 'the read was not recorded at all').toBeGreaterThan(0);
  expect(reads.some(entry => entry.role === 'worker' && entry.calls >= 1 && entry.errors >= 1),
    `the read was not recorded as a failure: ${JSON.stringify(outcome.stats)}`).toBe(true);
}, 300_000);

test('the same file is readable under the full access policy, so the boundary is the policy and not the path', async () => {
  const outcome = await readOutsideTheWorkCopy('full');

  // Full access means the host's file is in reach: the refusal in the standard
  // case is the policy at work, not a path that never existed.
  expect(outcome.history, 'the full access worker could not read the host file').toContain(MARKER);
  expect(outcome.refusal).toBe(MARKER);
}, 300_000);
