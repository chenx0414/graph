import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * What the master instance remembers, and what the budget refuses.
 *
 * An instance is a durable budget holder: it counts the tokens it spent, it
 * remembers which models it ran on, and it shares one budget scope with the
 * work it forked. Switching the conversation to another model must not reset
 * that history, and neither must a restart of the daemon - the scope keeps
 * its identity and its policy.
 *
 * The budget is a promise the daemon makes before every provider send: the
 * limit counts the usage that is already real, even while the operation that
 * produced it has not settled yet.
 *
 * The proof is the real daemon and real model services.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Endpoint {
  baseUrl: string;
  requests: { model: string; body: string }[];
  close: () => Promise<void>;
}

async function endpoint(text: string, usage: { prompt_tokens: number; completion_tokens: number }): Promise<Endpoint> {
  const requests: { model: string; body: string }[] = [];
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let model = '';
    try { model = String((JSON.parse(body) as { model?: string }).model ?? ''); } catch { model = ''; }
    requests.push({ model, body });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface NodeRunView {
  instance?: { id: string; used: number; budget: number | null; unlimited: boolean; modelsUsed: string[] };
  context?: { budgetScope?: { id: string; used: number; limit: number | null; unlimited: boolean; members: number } };
  operations?: { id: string; state: string; workerActive: boolean; reserved: number }[];
  invocations?: { id: string; usageSource: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }[];
  questions?: { id: string; kind: string; status: string; data?: unknown }[];
}

interface ConversationView {
  anchorTaskId: string;
  messages?: { role: string; text: string }[];
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-main-budget-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const first = await endpoint('First model reply.', { prompt_tokens: 40, completion_tokens: 10 });
  const next = await endpoint('Second model reply.', { prompt_tokens: 40, completion_tokens: 10 });
  const cheap = await endpoint('No suggestion.', { prompt_tokens: 2, completion_tokens: 1 });
  cleanup.push(() => first.close());
  cleanup.push(() => next.close());
  cleanup.push(() => cheap.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [
      { id: 'first', modelId: 'first', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: first.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
      { id: 'next', modelId: 'next', provider: 'graph-openai-next', grade: 'high', api: 'openai-completions',
        baseUrl: next.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
      { id: 'cheap', modelId: 'cheap', provider: 'graph-openai-cheap', grade: 'low', api: 'openai-completions',
        baseUrl: cheap.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
    ] },
    credentials: { local: { secretRef: 'GRAPH_MAIN_BUDGET_KEY' } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const launch = async () => {
    const daemon = await launchCli(root, {
      configPath, env: { GRAPH_MAIN_BUDGET_KEY: 'synthetic-only' }, extraArgs: ['--execute'],
    });
    return daemon;
  };
  const daemon = await launch();
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, configPath, project, first, next, cheap, launch, daemon, request };
}

/**
 * What the main operation reserves against the budget.
 *
 * The main operation reserves 2M tokens; each real provider send reserves the
 * context window plus the answer cap (32000+256 here). A first authoritative
 * 20000-token reply has to count against the following send before the
 * operation settles and commits that usage to the instance and its scope.
 */
test.each([
  { limit: 2_050_000, permitsFollowUp: false },
  { limit: 2_052_256, permitsFollowUp: true },
  { limit: 2_060_000, permitsFollowUp: true },
])('main budget $limit counts actual in-flight usage before its operation settles', async ({ limit, permitsFollowUp }) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-main-budget-inflight-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const sentinel = 'ACTUAL_MAIN_BUDGET_READ_SENTINEL';
  await writeFile(join(project, 'seed.txt'), sentinel);
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const provider = await openaiServer([
    { tools: [{ id: 'read-budget-seed', name: 'read', arguments: JSON.stringify({ path: join(project, 'seed.txt') }) }],
      usage: { prompt_tokens: 20_000, completion_tokens: 0 } },
    { text: 'Read the real seed file.', usage: { prompt_tokens: 40, completion_tokens: 10 },
      beforeReply: async () => { entered(); if (permitsFollowUp) await held; } },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    // The budget gate is the one the standard policy keeps: a full-access
    // host sends without asking the budget first.
    access: { mode: 'standard' },
    models: { entries: [
      { id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
    ] },
    credentials: { local: { secretRef: 'GRAPH_MAIN_BUDGET_KEY' } },
    limits: { defaultBudgetTokens: limit },
  }, null, 2));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_MAIN_BUDGET_KEY: 'synthetic-only' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const created = await request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Read seed.txt and tell me its complete contents.', requestId: 'begin' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const taskId = (created.body as { taskId: string }).taskId;
  const run = async (): Promise<NodeRunView> =>
    (await request(`/api/tasks/${taskId}/nodes/master/run`)).body as NodeRunView;

  if (permitsFollowUp) {
    // The second real send is on the wire and waiting for its reply.
    await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error('The main never sent the follow-up request')), 30_000))]);
    const inflight = await run();
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1])).toContain(sentinel);
    // The operation still holds its reservation and the first reply is not
    // committed yet, but its authoritative usage is already visible.
    expect(inflight.instance).toMatchObject({ used: 0, budget: limit, unlimited: false });
    expect(inflight.context?.budgetScope).toMatchObject({ used: 0, limit, unlimited: false, members: 1 });
    expect(inflight.operations?.[0]).toMatchObject({ state: 'dispatched', workerActive: true, reserved: 2_000_000 });
    expect(inflight.invocations?.[0]).toMatchObject({
      usageSource: 'authoritative',
      usage: { input: 20_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    release();
  }

  // The turn settles: the second send either went through or the budget
  // refused it and parked the master behind a question.
  await expect.poll(async () => (await run()).operations?.[0]?.state, { timeout: 30_000, interval: 250 })
    .toBe(permitsFollowUp ? 'succeeded' : 'interrupted');
  const settled = await run();
  expect(provider.requests).toHaveLength(permitsFollowUp ? 2 : 1);
  expect(settled.instance?.used).toBe(permitsFollowUp ? 20_050 : 20_000);
  expect(settled.context?.budgetScope?.used).toBe(permitsFollowUp ? 20_050 : 20_000);
  expect(settled.operations?.[0]).toMatchObject({ state: permitsFollowUp ? 'succeeded' : 'interrupted', reserved: 0, workerActive: false });
  const budgetQuestions = (settled.questions ?? []).filter(question => question.kind === 'budget' && question.status === 'open');
  if (permitsFollowUp) {
    expect(budgetQuestions).toEqual([]);
    const conversation = (await request(`/api/conversations/${conversationId}`)).body as ConversationView;
    expect((conversation.messages ?? []).filter(message => message.role === 'assistant').at(-1)?.text)
      .toContain('Read the real seed file.');
  } else {
    expect(budgetQuestions).toHaveLength(1);
    expect(JSON.stringify(budgetQuestions)).toContain('Shared context budget exhausted');
  }
}, 120_000);

test('main model history and unlimited scope policy survive a public model switch and runtime restart', async () => {
  const f = await fixture();
  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'first', text: 'First message.', requestId: 'first' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const taskId = (created.body as { taskId: string }).taskId;

  const run = async (): Promise<NodeRunView> => {
    const view = await f.request(`/api/tasks/${taskId}/nodes/master/run`);
    return view.body as NodeRunView;
  };
  const answered = async () => {
    await expect.poll(async () => {
      const view = await f.request(`/api/conversations/${conversationId}`);
      const body = view.body as ConversationView;
      return (body.messages ?? []).some(message => message.role === 'assistant');
    }, { timeout: 30_000, interval: 250 }).toBe(true);
  };

  await answered();
  const before = await run();
  // The first turn ran on the first model, and its reply plus the composer's
  // suggestion are both charged to the instance.
  expect(f.first.requests).toHaveLength(1);
  expect(f.next.requests).toHaveLength(0);
  expect(before.instance?.used).toBe(53);
  expect(before.instance?.budget).toBe(3_000_000);
  expect(before.instance?.unlimited).toBe(false);
  expect(before.instance?.modelsUsed).toEqual(['first']);
  expect(before.context?.budgetScope?.used).toBe(53);
  expect(before.context?.budgetScope?.limit).toBe(3_000_000);
  expect(before.context?.budgetScope?.unlimited).toBe(false);
  expect(before.context?.budgetScope?.members).toBe(1);
  const scopeId = before.context?.budgetScope?.id;

  // The budget of the master becomes unlimited.
  const unbudgeted = await f.request(`/api/tasks/${taskId}/budget`, {
    method: 'POST', body: JSON.stringify({ nodeId: 'master', tokens: null, requestId: 'unlimited' }),
  });
  expect(unbudgeted.status, JSON.stringify(unbudgeted.body)).toBe(200);

  // The conversation moves to another model.
  const switched = await f.request(`/api/conversations/${conversationId}/model`, {
    method: 'POST', body: JSON.stringify({ model: 'next', thinkingLevel: 'off', requestId: 'switch-model' }),
  });
  expect(switched.status, JSON.stringify(switched.body)).toBe(200);

  const changed = await run();
  // The switch changed neither the identity of the instance nor its history.
  expect(changed.instance?.id).toBe(before.instance?.id);
  expect(changed.instance?.used).toBe(53);
  expect(changed.instance?.budget).toBeNull();
  expect(changed.instance?.unlimited).toBe(true);
  expect(changed.instance?.modelsUsed).toEqual(['first']);
  expect(changed.context?.budgetScope?.id).toBe(scopeId);
  expect(changed.context?.budgetScope?.used).toBe(53);
  expect(changed.context?.budgetScope?.limit).toBeNull();
  expect(changed.context?.budgetScope?.unlimited).toBe(true);

  // A restart of the daemon keeps both: the instance and its scope.
  await f.daemon.close();
  const restarted = await f.launch();
  cleanup.push(() => restarted.close());
  const reopened = (await (await restarted.request(`/api/tasks/${taskId}/nodes/master/run`)).json()) as NodeRunView;
  expect(reopened.instance?.id).toBe(before.instance?.id);
  expect(reopened.instance?.used).toBe(53);
  expect(reopened.instance?.budget).toBeNull();
  expect(reopened.instance?.unlimited).toBe(true);
  expect(reopened.instance?.modelsUsed).toEqual(['first']);
  expect(reopened.context?.budgetScope?.id).toBe(scopeId);
  expect(reopened.context?.budgetScope?.used).toBe(53);
  expect(reopened.context?.budgetScope?.limit).toBeNull();
  expect(reopened.context?.budgetScope?.unlimited).toBe(true);

  // The next turns run on the model the conversation now names, and the
  // history keeps both models.
  for (const [requestId, text, used] of [['second', 'Second message.', 106], ['third', 'Third message.', 159]] as const) {
    const sent = await restarted.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text, requestId }),
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await expect.poll(async () => {
      const body = (await (await restarted.request(`/api/conversations/${conversationId}`)).json()) as ConversationView;
      return (body.messages ?? []).filter(message => message.role === 'assistant').length;
    }, { timeout: 30_000, interval: 250 }).toBeGreaterThanOrEqual(requestId === 'second' ? 2 : 3);
    const current = (await (await restarted.request(`/api/tasks/${taskId}/nodes/master/run`)).json()) as NodeRunView;
    expect(current.instance?.id, requestId).toBe(before.instance?.id);
    expect(current.instance?.used, requestId).toBe(used);
    expect(current.instance?.budget, requestId).toBeNull();
    expect(current.instance?.unlimited, requestId).toBe(true);
    expect(current.instance?.modelsUsed, requestId).toEqual(['first', 'next']);
    expect(current.context?.budgetScope?.id, requestId).toBe(scopeId);
    expect(current.context?.budgetScope?.used, requestId).toBe(used);
    expect(current.context?.budgetScope?.limit, requestId).toBeNull();
    expect(current.context?.budgetScope?.unlimited, requestId).toBe(true);
    expect(current.context?.budgetScope?.members, requestId).toBe(1);
  }

  // The first model was asked once, the new model twice, and the cheap model
  // produced the composer's suggestion each time.
  expect(f.first.requests).toHaveLength(1);
  expect(f.next.requests).toHaveLength(2);
  expect(f.cheap.requests).toHaveLength(3);
  expect(f.next.requests.map(request => request.model)).toEqual(['next', 'next']);
  expect(f.next.requests[0]!.body).toContain('First model reply.');
}, 180_000);
