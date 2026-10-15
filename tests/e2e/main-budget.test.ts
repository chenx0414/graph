import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { standardAccessPolicy } from '../../src/core/access-policy.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;
function mainRun(runtime: Runtime, taskId: string) {
  const run = runtime.nodeRun(taskId, 'master');
  if (!('context' in run) || !run.context || !run.instance || !run.context.budgetScope) {
    throw new Error('Expected the actual main instance and durable budget scope');
  }
  return run;
}

// The main operation reserves 2M tokens; each actual SDK send reserves 32000+256.
// A first authoritative 20000-token reply must affect the following send before
// operation settlement commits that usage to the main instance/scope.
test.each([
  { limit: 2_050_000, permitsFollowUp: false },
  { limit: 2_052_256, permitsFollowUp: true },
  { limit: 2_060_000, permitsFollowUp: true },
])('main budget $limit counts actual in-flight usage before its operation settles', async ({ limit, permitsFollowUp }) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-budget-inflight-'));
  const project = join(root, 'project'); await mkdir(project);
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
  let runtime: Runtime | undefined; let drive: Promise<unknown> | undefined;
  try {
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
      access: () => standardAccessPolicy(), limits: { defaultBudgetTokens: limit },
      catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
      models: { apiKey: 'synthetic-only', modelRuntime: provider.runtime, entries: [{ id: 'local',
        provider: provider.model.provider, grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl,
        contextWindow: 32_000, maxTokens: 256 }] } });
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'Read the requested project file, then answer.');
    const created = await runtime.conversations.create({ projectId: 'p', text: 'Read seed.txt and tell me its complete contents.', requestId: 'begin' });
    const taskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    drive = runtime.host.drive();
    if (permitsFollowUp) {
      await Promise.race([arrived, drive.then(() => { throw new Error('Main ended before the expected second real provider send'); })]);
      const inflight = mainRun(runtime, taskId);
      expect(provider.requests).toHaveLength(2);
      expect(JSON.stringify(provider.requests[1])).toContain(sentinel);
      expect(inflight.instance).toMatchObject({ used: 0, budget: limit, unlimited: false });
      expect(inflight.context!.budgetScope).toMatchObject({ used: 0, limit, unlimited: false, members: 1 });
      expect(inflight.operations).toMatchObject([{ state: 'dispatched', workerActive: true, reserved: 2_000_000 }]);
      expect(inflight.invocations[0]).toMatchObject({ usageSource: 'authoritative', usage: { input: 20_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
      release();
    }
    await drive; drive = undefined;
    const settled = mainRun(runtime, taskId);
    expect(provider.requests).toHaveLength(permitsFollowUp ? 2 : 1);
    expect(settled.instance!.used).toBe(permitsFollowUp ? 20_050 : 20_000);
    expect(settled.context!.budgetScope!.used).toBe(permitsFollowUp ? 20_050 : 20_000);
    expect(settled.operations).toMatchObject([{ state: permitsFollowUp ? 'succeeded' : 'interrupted', reserved: 0, workerActive: false }]);
    if (permitsFollowUp) {
      expect(settled.questions.filter(question => question.kind === 'budget' && question.status === 'open')).toEqual([]);
      expect((await runtime.conversations.view(created.conversationId)).messages.filter(message => message.role === 'assistant').at(-1)?.text)
        .toContain('Read the real seed file.');
    } else {
      expect(settled.questions).toMatchObject([{ kind: 'budget', status: 'open' }]);
      expect(JSON.stringify(settled.questions)).toContain('Shared context budget exhausted');
    }
  } finally {
    release(); await drive?.catch(() => undefined); await runtime?.close(); await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test('main model history and unlimited scope policy survive a public model switch and runtime restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-budget-history-'));
  const project = join(root, 'project'); await mkdir(project);
  const first = await openaiServer([{ text: 'First model reply.', usage: { prompt_tokens: 40, completion_tokens: 10 } }]);
  const next = await openaiServer([
    { text: 'Second model reply.', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'Same second model again.', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ]);
  const cheap = await openaiServer(Array.from({ length: 3 }, () => ({ text: 'No suggestion.', usage: { prompt_tokens: 2, completion_tokens: 1 } })));
  const options: Parameters<typeof openTaskRuntime>[0] = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    access: () => standardAccessPolicy(), limits: { defaultBudgetTokens: 3_000_000 },
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    master: { action: 'master', definitionVersion: 'master@1', model: 'first' },
    models: { apiKey: 'synthetic-only', modelRuntime: first.runtime, entries: ([['first', 'first', first], ['next', 'next', next], ['cheap', 'cheap', cheap]] as const).map(([id, modelId, provider]) => ({
      id, modelId, provider: provider.model.provider, grade: id === 'cheap' ? 'low' : 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
    })) } };
  let runtime: Runtime | undefined;
  try {
    runtime = await openTaskRuntime(options);
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'Answer each user message.');
    const created = await runtime.conversations.create({ projectId: 'p', text: 'First message.', requestId: 'first' });
    await runtime.host.drive();
    const taskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    const before = mainRun(runtime, taskId);
    expect(first.requests).toHaveLength(1); expect(next.requests).toHaveLength(0);
    expect(before.instance).toMatchObject({ used: 53, budget: 3_000_000, unlimited: false, modelsUsed: ['first'] });
    expect(before.context!.budgetScope).toMatchObject({ ownerInstanceId: before.instance!.id, members: 1, used: 53, limit: 3_000_000, unlimited: false });
    const scopeId = before.context!.budgetScope!.id;
    await runtime.user.task(taskId).setBudget({ nodeId: 'master', tokens: null, requestId: 'unlimited' });
    await runtime.conversations.selectModel(created.conversationId, { model: 'next', thinkingLevel: 'off', requestId: 'switch-model' });
    const changed = mainRun(runtime, taskId);
    expect(changed.instance).toMatchObject({ id: before.instance!.id, used: 53, budget: null, unlimited: true, modelsUsed: ['first'] });
    expect(changed.context!.budgetScope).toMatchObject({ id: scopeId, used: 53, limit: null, unlimited: true });
    await runtime.close(); runtime = await openTaskRuntime(options);
    const reopened = mainRun(runtime, taskId);
    expect(reopened.instance).toMatchObject({ id: before.instance!.id, used: 53, budget: null, unlimited: true, modelsUsed: ['first'] });
    expect(reopened.context!.budgetScope).toMatchObject({ id: scopeId, used: 53, limit: null, unlimited: true });
    for (const [requestId, text, used] of [['second', 'Second message.', 106], ['third', 'Third message.', 159]] as const) {
      await runtime.conversations.chat(created.conversationId, { text, requestId }); await runtime.host.drive();
      const run = mainRun(runtime, taskId);
      expect(run.instance).toMatchObject({ id: before.instance!.id, used, budget: null, unlimited: true, modelsUsed: ['first', 'next'] });
      expect(run.context!.budgetScope).toMatchObject({ id: scopeId, used, limit: null, unlimited: true, members: 1 });
    }
    expect(first.requests).toHaveLength(1); expect(next.requests).toHaveLength(2); expect(cheap.requests).toHaveLength(3);
    expect(next.requests).toMatchObject([{ model: 'next' }, { model: 'next' }]);
    expect(JSON.stringify(next.requests[0])).toContain('First model reply.');
    expect((await runtime.conversations.view(created.conversationId)).messages.filter(message => message.role === 'assistant').at(-1)?.text)
      .toContain('Same second model again.');
  } finally {
    await runtime?.close(); await first.close(); await next.close(); await cheap.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
