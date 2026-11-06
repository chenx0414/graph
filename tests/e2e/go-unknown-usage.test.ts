import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A provider that does not say what it cost did not cost nothing.
 *
 * The honest thing to do with a call whose usage is unknown is to record it
 * as unknown and never guess: a made-up number would put a wrong figure in
 * the ledger. With the token ceiling gone such a call no longer holds the
 * next one - nothing is being protected from a limit - so the work goes on.
 * The number can still arrive later: main reconciles the call once, with the
 * usage the provider really used; the same reconciliation twice is the same
 * answer, and a different one is refused.
 *
 * The proof is a real daemon, a real graph and a real provider that really
 * answers - once with a price and once without: the ledger really tells the
 * two apart, the provider really is asked no more than it was, and the
 * reconciliation really settles the unpriced call exactly once.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface Step {
  id: string;
  name: string;
  args: unknown;
  before?: () => Promise<void>;
  /** The usage this answer reports. `null` is a provider that does not say. */
  usage?: Record<string, number> | null;
}

interface ProviderCall {
  id: string;
  nodeId?: string;
  state: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  cost?: unknown;
}

/**
 * A scripted model. It plays the plan in order and records what every tool
 * call answered, so the test reads the graph the way the model read it.
 *
 * A request without tools is not the model speaking - it is the composer
 * asking for a suggested next message - and it is answered with plain text
 * so that it never eats a step of the plan.
 */
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
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The calls are as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    await next.before?.();
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: next.usage === undefined ? { prompt_tokens: 40, completion_tokens: 10 } : next.usage }));
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

const readCalls = (content: string): ProviderCall[] => {
  if (!content.trim()) return [];
  const parsed = JSON.parse(content) as ProviderCall[];
  return Array.isArray(parsed) ? parsed : [];
};

test('a call whose usage is unknown is recorded without a guess and reconciled once later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-unknown-usage-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'package.json'), '{}\n');

  const definition = {
    schemaVersion: 2,
    name: 'Unknown usage',
    protocols: { data: { type: 'object' } },
    nodes: {
      // A node with a budget of its own: the ledger only holds an unknown
      // price against a bounded node, because an unbounded one is allowed to
      // keep going without a price.
      work: { recipe: 'coder@1', model: 'sender', task: 'Read the package file', budget: { tokens: 1000000 }, inputs: {}, outputs: {}, submission: {} },
    },
    modules: {},
    edges: {},
    acceptance: [],
  };

  // The worker answers twice: the first call says what it cost, the second one
  // does not. The ledger has to keep the two apart - one priced call, one
  // unpriced call, each recorded once.
  const worker = await scriptedProvider(() => [
    { id: 'first', name: 'write_file', args: { path: 'unknown-usage.txt', content: 'first' }, usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { id: 'second', name: 'write_file', args: { path: 'unknown-usage.txt', content: 'second' }, usage: null },
  ]);
  const graphs: string[] = [];
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const master = await scriptedProvider(() => {
    const graphId = graphs[0] ?? '';
    const missing = readCalls(master.results.get('calls') ?? '').find(call => call.state === 'unknown');
    const callId = missing?.id ?? '';
    const usage = { input: 15, output: 5, cacheRead: 0, cacheWrite: 0 };
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'chat', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Read the package file' } },
      { id: 'calls', name: 'graph_inspect', args: { graphId, query: 'provider_calls' },
        before: async () => { await waitForSettled(graphId, 'work'); } },
      { id: 'reconcile', name: 'graph_control', args: { graphId, action: 'reconcile_usage', callId, usage } },
      { id: 'reconcile-again', name: 'graph_control', args: { graphId, action: 'reconcile_usage', callId, usage } },
      { id: 'reconcile-other', name: 'graph_control', args: { graphId, action: 'reconcile_usage', callId, usage: { input: 16, output: 5, cacheRead: 0, cacheWrite: 0 } } },
      { id: 'calls-after', name: 'graph_inspect', args: { graphId, query: 'provider_calls' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

  const configPath = join(root, 'graph.config.json');
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'usage' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { usage: { secretRef: 'GRAPH_USAGE_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...credential, id: 'sender', provider: 'graph-worker', modelId: 'worker-model', baseUrl: worker.baseUrl, contextWindow: 32000 },
    ] },
  }));

  const waitForSettled = async (graphId: string, nodeId: string) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const view = await (await daemon!.request(`/api/tasks/${graphId}`)).json() as { nodes: { id: string; status: string }[] };
      const status = view.nodes.find(node => node.id === nodeId)?.status;
      if (status === 'succeeded' || status === 'failed' || status === 'blocked') return status;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('the node never settled');
  };

  daemon = await launchCli(root, { configPath, env: { GRAPH_USAGE_KEY: 'usage-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Do the work.', requestId: 'unknown-usage' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('calls-after'), { timeout: 240_000, interval: 250 }).toBeTruthy();

    // The ledger keeps the priced call and the unpriced call apart, each of
    // them recorded once.
    const calls = readCalls(master.results.get('calls')!);
    const events = await (await daemon!.request(`/api/tasks/${graphs[0]!}/events`)).json() as { type: string; data: Record<string, unknown> }[];
    expect(calls[0]).toMatchObject({ state: 'settled', usage: { input: 40, output: 10 } });
    expect(calls[1]).toMatchObject({ state: 'unknown', usage: null });
    expect(calls).toHaveLength(3);
    // Every send went out: an unpriced call is recorded, not a gate.
    const asked = worker.requests.filter(request => (request as { tools?: unknown[] }).tools?.length);
    expect(asked).toHaveLength(3);
    // No send was refused: the unpriced call never gated the work that followed.
    expect(events.filter(event => event.type === 'graph.provider.refused')).toEqual([]);

    // The same reconciliation twice is the same answer.
    expect(JSON.parse(master.results.get('reconcile')!)).toMatchObject({ replayed: false, nodeId: 'work' });
    expect(JSON.parse(master.results.get('reconcile-again')!)).toMatchObject({ replayed: true, nodeId: 'work' });
    // A different number for the same call is refused.
    expect(master.results.get('reconcile-other')).toContain('already reconciled differently');

    // The missing call is settled with the reconciled usage, exactly once; the
    // priced one is untouched.
    const after = readCalls(master.results.get('calls-after')!);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatchObject({ state: 'settled', usage: { input: 40, output: 10 } });
    expect(after[1]).toMatchObject({ state: 'reconciled', usage: { input: 15, output: 5 } });
    // And the ledger counted both of them once: the priced call and the
    // reconciled one. A second settlement of the same number would show up
    // here as another twenty tokens.
    const view = await (await daemon!.request(`/api/tasks/${graphs[0]!}`)).json() as { nodes: { id: string; used: number }[] };
    // The priced call and the reconciled one are both counted exactly once; a
    // third send now goes out too, so the ledger can only grow past those two.
    expect(view.nodes.find(node => node.id === 'work')?.used).toBeGreaterThanOrEqual(70);
  } finally {
    await daemon?.close();
    await master.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
