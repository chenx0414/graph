import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A model that cannot be called is refused, and the refusal is explained.
 *
 * A turn needs a model whose key resolves. When there is none, the request
 * cannot be answered - but it must not disappear: the user is told why, the
 * message is kept, and the message really runs once a key is there again.
 * A graph node whose own model has no key fails with the reason, and the
 * provider is never contacted.
 *
 * The proof is the real daemon: the key is really revoked through the
 * privileged bridge, and the provider records what it was asked.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall {
  id: string;
  name: string;
  args: unknown;
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
}

/** A provider that answers one call after another and records the answers. */
async function masterProvider(plan: (graphId: string) => MasterCall[]) {
  const requests: ChatBody[] = [];
  const results = new Map<string, string>();
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking: it is the master
    // asking for a next-message suggestion.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan(graphId).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'As expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    await next.before?.();
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    results,
    graphId: () => graphId,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** A provider that answers a turn and records that it was asked. */
async function answeringProvider(text: string) {
  let requests = 0;
  const server: Server = createServer((_request, response) => {
    requests++;
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface ConversationMessage { role: string; kind: string; text: string; state: string }

test('a conversation that no model can be called is refused with the reason, and runs once a key is there', async () => {
  const provider = await answeringProvider('Answered.');
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-credential-refusal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{
      id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_LOCAL_KEY: 'key-local' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const token = (await readFile(join(root, 'state', 'app-token'), 'utf8')).trim();
  const bridge = async (body: Record<string, unknown>) => {
    const response = await daemon.request('/api/app/secret', {
      method: 'POST', headers: { 'x-graph-app-token': token }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as { applied?: boolean; reason?: string } };
  };

  // The key is taken out of service: the model has no key to be called with.
  const revoked = await bridge({ ref: 'GRAPH_LOCAL_KEY', value: null });
  expect(revoked.status).toBe(200);

  const created = await request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'No key here', requestId: 'refusal' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  // The user is told why, instead of waiting for a reply that cannot come.
  await expect.poll(async () => {
    const view = await request(`/api/conversations/${conversationId}`);
    const messages = (view.body as { messages?: ConversationMessage[] }).messages ?? [];
    return messages.some(message => message.role === 'system' && message.kind === 'error');
  }, { timeout: 30_000, interval: 250 }).toBe(true);
  const refused = await request(`/api/conversations/${conversationId}`);
  const messages = (refused.body as { messages?: ConversationMessage[] }).messages ?? [];
  const notice = messages.find(message => message.role === 'system' && message.kind === 'error');
  expect(notice?.text, JSON.stringify(messages)).toContain('No credential bound for model local');
  // The message is kept: it was never delivered, so it still runs later.
  const asked = messages.find(message => message.role === 'user');
  expect(asked?.state).toBe('pending');
  // And nothing was sent: the request is refused before the provider.
  expect(provider.requests()).toBe(0);

  // The key comes back: the host asks the desktop to store it, the desktop confirms.
  const stored = await bridge({ ref: 'GRAPH_LOCAL_KEY', value: 'key-local-again' });
  expect(stored.body.applied, JSON.stringify(stored.body)).toBe(true);
  const confirmed = await bridge({ ref: 'GRAPH_LOCAL_KEY', value: 'key-local-again', persisted: true });
  expect(confirmed.body.applied, JSON.stringify(confirmed.body)).toBe(true);

  // The kept message runs now, and the master really answers it.
  await expect.poll(async () => {
    const view = await request(`/api/conversations/${conversationId}`);
    const list = (view.body as { messages?: ConversationMessage[] }).messages ?? [];
    return list.some(message => message.role === 'assistant' && message.text === 'Answered.');
  }, { timeout: 60_000, interval: 250 }).toBe(true);
  const answered = await request(`/api/conversations/${conversationId}`);
  const final = (answered.body as { messages?: ConversationMessage[] }).messages ?? [];
  expect(final.find(message => message.role === 'user')?.state).toBe('delivered');
  expect(provider.requests()).toBe(1);
}, 180_000);

const NO_KEY_DEFINITION = {
  schemaVersion: 2,
  name: 'No key node',
  protocols: { data: { type: 'object' } },
  nodes: {
    work: {
      recipe: 'coder@1', model: 'other', task: 'Process the input',
      inputs: { job: { protocol: 'data' } }, outputs: { out: { protocol: 'data' } }, submission: {},
    },
  },
  modules: {},
  edges: {}, inputs: {},
  outputs: { result: { from: 'work.out', protocol: 'data' } },
};

test('a graph node whose own model has no key fails with the reason and never reaches the provider', async () => {
  const master = await masterProvider(graphId => [
    { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: NO_KEY_DEFINITION } },
    { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'work', input: 'job', value: { marker: 'work' } } },
  ]);
  cleanup.push(() => master.close());
  // The node's own model: it is configured, but its key is nowhere to be found.
  const node = await answeringProvider('The answer.');
  cleanup.push(() => node.close());

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-no-key-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: {
      main: { secretRef: 'GRAPH_MAIN_KEY' },
      other: { secretRef: 'GRAPH_OTHER_KEY' },
    },
    models: { entries: [
      { id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
        baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'main' },
      { id: 'other', provider: 'graph-node', modelId: 'other-model', grade: 'high', api: 'openai-completions',
        baseUrl: node.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'other' },
    ] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_MAIN_KEY: 'main-synthetic' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  const started = await request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the node without a key.', requestId: 'node-no-key' }),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await expect.poll(() => master.results.get('send'), { timeout: 120_000, interval: 250 }).toBeTruthy();

  // The node fails, and the failure names the model that has no key.
  const graphId = master.graphId();
  expect(graphId).not.toBe('');
  await expect.poll(async () => {
    const view = await request(`/api/tasks/${graphId}`);
    const nodes = (view.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
    return nodes.find(candidate => candidate.id === 'work')?.status;
  }, { timeout: 60_000, interval: 250 }).toBe('failed');
  const events = await request(`/api/tasks/${graphId}/events?after=0&limit=200`);
  const failed = (Array.isArray(events.body) ? events.body : [])
    .find((event: { type?: string }) => event.type === 'graph.node.failed');
  expect(failed, JSON.stringify(events.body)).toBeTruthy();
  expect((failed.data as { nodeId?: string; reason?: string }).nodeId).toBe('work');
  expect((failed.data as { reason?: string }).reason ?? '').toMatch(/no credential bound/i);

  // The provider of that model was never asked: the call was refused first.
  expect(node.requests()).toBe(0);
}, 240_000);
