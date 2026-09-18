import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Operation, OperationResult } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-conversation-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function scripted(handler: (operation: Operation) => Promise<OperationResult> | OperationResult): ActionAdapter {
  return { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => handler(operation) };
}

async function withRuntime(root: string, handler: (operation: Operation) => Promise<OperationResult> | OperationResult, master = true) {
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: scripted(handler) },
    ...(master ? { master: { action: 'master', definitionVersion: 'master@1', model: 'm' } } : {}),
  });
  cleanup.push(() => runtime.close());
  return runtime;
}

test('a conversation starts and chats without a project or feature task', async () => {
  const root = await temp('start');
  const seen: Operation[] = [];
  const runtime = await withRuntime(root, operation => { seen.push(operation); return { outcome: 'completed', output: { text: '先告诉我你想解决什么，我可以先看这个项目。' }, usage }; });
  const created = await runtime.conversations.create({ text: '这个项目很乱，先帮我看看。', requestId: 'create-1' });
  const conversation = await runtime.conversations.view(created.conversationId);
  expect(conversation.projectId).toBeNull();
  expect(conversation.messages.map(message => message.role)).toEqual(['user']);
  expect(conversation.messages[0]!.state).toBe('pending');
  expect(conversation.tasks).toEqual([]);
  expect(await runtime.user.list()).toEqual([]);

  const result = await runtime.host.runReady();
  expect(result.dispatched).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.messages).toEqual([{ id: conversation.messages[0]!.id, text: '这个项目很乱，先帮我看看。', requirementVersion: 1 }]);
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.map(message => [message.role, message.state])).toEqual([['user', 'delivered'], ['assistant', 'done']]);
  expect(after.messages[1]!.text).toContain('先告诉我');
  expect(after.master?.status).toBe('succeeded');
  expect(after.requirementVersion).toBe(1);
  // Discussion never dispatches implementation work.
  expect(after.tasks).toEqual([]);
  expect(await runtime.user.list()).toEqual([]);
});

test('conversations can be archived and restored without deleting their history', async () => {
  const root = await temp('archive');
  const runtime = await withRuntime(root, () => ({ outcome: 'completed', output: { text: 'ok' }, usage }));
  const created = await runtime.conversations.create({ text: '稍后继续', requestId: 'archive-create' });

  expect((await runtime.conversations.list()).map(item => item.id)).toContain(created.conversationId);
  const archived = await runtime.conversations.archive(created.conversationId, 'archive-1');
  expect(archived).toMatchObject({ archived: true, conversationId: created.conversationId });
  expect(await runtime.conversations.list()).toEqual([]);
  expect((await runtime.conversations.list({ archived: true }))[0]).toMatchObject({
    id: created.conversationId,
    archivedAt: archived.archivedAt,
  });
  expect((await runtime.conversations.view(created.conversationId)).archived).toBe(true);

  const restored = await runtime.conversations.unarchive(created.conversationId, 'archive-2');
  expect(restored).toMatchObject({ archived: false, archivedAt: null });
  expect((await runtime.conversations.list()).map(item => item.id)).toContain(created.conversationId);
  expect((await runtime.conversations.view(created.conversationId)).messages).toHaveLength(1);
});

test('conversation model and thinking selection applies to the next master turn', async () => {
  const root = await temp('model-selection');
  const entries = [
    {
      id: 'm1', provider: 'synthetic', grade: 'medium' as const, api: 'openai-completions' as const,
      baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: false,
    },
    {
      id: 'm2', provider: 'synthetic', grade: 'high' as const, api: 'openai-completions' as const,
      baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: true,
    },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    models: { entries, modelRuntime: {} as never },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm1' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '切换模型', requestId: 'model-create' });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm1', thinkingLevel: 'off' });

  const selected = await runtime.conversations.selectModel(created.conversationId, {
    model: 'm2', thinkingLevel: 'high', requestId: 'model-select',
  });
  expect(selected).toMatchObject({ model: 'm2', thinkingLevel: 'high', changed: true });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm2', thinkingLevel: 'high' });

  const clamped = await runtime.conversations.selectModel(created.conversationId, {
    model: 'm1', thinkingLevel: 'high', requestId: 'model-select-clamped',
  });
  expect(clamped).toMatchObject({ model: 'm1', thinkingLevel: 'off' });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm1', thinkingLevel: 'off' });
});

test('new conversations inherit the master model default thinking level', async () => {
  const root = await temp('default-thinking');
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    models: {
      entries: [{
        id: 'm-default', provider: 'synthetic', grade: 'high', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: true,
        defaultThinkingLevel: 'xhigh',
      }],
      modelRuntime: {} as never,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm-default' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '使用模型默认思考强度', requestId: 'default-thinking' });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({
    model: 'm-default',
    thinkingLevel: 'xhigh',
  });
});

test('a new conversation can choose its model and thinking before the first turn', async () => {
  const root = await temp('create-selection');
  const entries = [
    {
      id: 'm1', provider: 'synthetic', grade: 'medium' as const, api: 'openai-completions' as const,
      baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: false,
    },
    {
      id: 'm2', provider: 'synthetic', grade: 'high' as const, api: 'openai-completions' as const,
      baseUrl: 'http://127.0.0.1:1', contextWindow: 64_000, maxTokens: 256, reasoning: true, defaultThinkingLevel: 'low' as const,
    },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    models: { entries, modelRuntime: {} as never },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm1' },
  });
  cleanup.push(() => runtime.close());
  expect(runtime.defaultModel()).toBe('m1');
  const created = await runtime.conversations.create({
    text: '预选模型', model: 'm2', thinkingLevel: 'high', requestId: 'create-selection',
  });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm2', thinkingLevel: 'high' });
  await expect(runtime.conversations.create({ text: '坏模型', model: 'missing', requestId: 'create-bad' }))
    .rejects.toMatchObject({ code: 'model_unavailable' });
});

test('messages sent while the master is running are answered one queued turn at a time', async () => {
  const root = await temp('queue');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: Operation[] = [];
  const runtime = await withRuntime(root, async operation => {
    seen.push(operation);
    if (seen.length === 1) await gate;
    return { outcome: 'completed', output: { text: `答：${operation.context.messages?.map(message => message.text).join(' / ')}` }, usage };
  });
  const created = await runtime.conversations.create({ text: '第一条', requestId: 'create' });
  const first = runtime.host.runReady();
  await new Promise(resolve => setTimeout(resolve, 30));
  await runtime.conversations.chat(created.conversationId, { text: '第二条', requestId: 'chat-2' });
  await runtime.conversations.chat(created.conversationId, { text: '第三条', requestId: 'chat-3' });
  const queued = await runtime.conversations.view(created.conversationId);
  expect(queued.messages.filter(message => message.role === 'user').map(message => message.state)).toEqual(['delivered', 'queued', 'queued']);
  release();
  await first;
  await runtime.host.runReady();
  expect(seen).toHaveLength(2);
  expect(seen[1]!.context.messages?.map(message => message.text)).toEqual(['第二条']);
  const middle = await runtime.conversations.view(created.conversationId);
  expect(middle.messages.find(message => message.text === '第二条')?.state).toBe('delivered');
  expect(middle.messages.find(message => message.text === '第三条')?.state).toBe('queued');
  await runtime.host.runReady();
  expect(seen).toHaveLength(3);
  expect(seen[2]!.context.messages?.map(message => message.text)).toEqual(['第三条']);
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.filter(message => message.role === 'user').every(message => message.state === 'delivered')).toBe(true);
  expect(after.messages.filter(message => message.role === 'assistant')).toHaveLength(3);
  expect(after.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual([
    '答：第一条',
    '答：第二条',
    '答：第三条',
  ]);
});

test('the master prompt suggestion is stored with the assistant reply', async () => {
  const root = await temp('suggestion');
  const runtime = await withRuntime(root, () => ({
    outcome: 'completed',
    output: { text: '第一阶段检查完成。', suggestedPrompt: '继续检查测试覆盖和失败分支。' },
    usage,
  }));
  const created = await runtime.conversations.create({ text: '先检查项目。', requestId: 'suggestion' });
  await runtime.host.runReady();
  const conversation = await runtime.conversations.view(created.conversationId);
  const assistant = conversation.messages.find(message => message.role === 'assistant')!;
  expect((assistant.data as { suggestedPrompt?: unknown } | null)?.suggestedPrompt).toBe('继续检查测试覆盖和失败分支。');
});

test('queued messages can steer the active master turn', async () => {
  const root = await temp('steer');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const steered: string[] = [];
  const adapter: ActionAdapter = {
    kind: 'agent',
    reserveTokens: 100,
    prepare: async () => async () => {
      await gate;
      return { outcome: 'completed', output: { text: '已根据引导继续完成。' }, usage };
    },
    steer: async (_operation, text) => { steered.push(text); },
  };
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: adapter },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '开始检查。', requestId: 'steer' });
  const firstTurn = runtime.host.runReady();
  await expect.poll(async () => (await runtime.conversations.view(created.conversationId)).master?.status).toBe('running');
  await runtime.conversations.chat(created.conversationId, { text: '先看测试覆盖。', requestId: 'steer-1' });
  await runtime.conversations.chat(created.conversationId, { text: '再看失败分支。', requestId: 'steer-2' });

  const steeredReceipt = await runtime.conversations.steer(created.conversationId, { requestId: 'steer-guide' });
  expect(steeredReceipt).toMatchObject({ state: 'steered', steered: 2 });
  expect(steered).toEqual(['先看测试覆盖。\n\n再看失败分支。']);
  const guided = await runtime.conversations.view(created.conversationId);
  expect(guided.messages.filter(message => message.role === 'user').map(message => message.state)).toEqual(['delivered', 'delivered', 'delivered']);
  expect(guided.messages.filter(message => message.role === 'user').slice(1).every(message => message.operationId)).toBe(true);

  release();
  await firstTurn;
  const completed = await runtime.conversations.view(created.conversationId);
  expect(completed.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  expect(completed.messages.at(-1)?.text).toBe('已根据引导继续完成。');
});

test('drafts version on the same requirement and only the latest can be confirmed', async () => {
  const root = await temp('draft');
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'draft ready' }, usage })) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '做一个最小可用版', requestId: 'create' });
  await runtime.host.runReady();
  const conversation = await runtime.conversations.view(created.conversationId);
  const anchorTaskId = conversation.anchorTaskId;

  const proposal = (summary: string) => ({
    requirementVersion: 1, summary,
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  });
  await runtime.supervisor(anchorTaskId).propose(proposal('旧方案'), 'proposal-1');
  await runtime.supervisor(anchorTaskId).propose(proposal('新方案'), 'proposal-2');
  const drafted = await runtime.conversations.view(created.conversationId);
  expect(drafted.proposal?.version).toBe(2);
  expect(drafted.proposal?.spec.summary).toBe('新方案');
  expect(drafted.proposalHistory.map(item => ({ version: item.version, summary: item.summary, accepted: item.accepted, stale: item.stale }))).toEqual([
    { version: 1, summary: '旧方案', accepted: false, stale: false },
    { version: 2, summary: '新方案', accepted: false, stale: false },
  ]);
  expect((await runtime.conversations.proposal(created.conversationId, 1)).spec.summary).toBe('旧方案');
  await expect(runtime.conversations.proposal(created.conversationId, 99)).rejects.toMatchObject({ code: 'not_found' });

  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm-old' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm-new' });
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.requirementVersion).toBe(2);
  expect(after.tasks).toHaveLength(1);
  expect(after.tasks[0]!.id).toBe(confirmed.taskId);
  expect(after.tasks[0]!.phase).toBe('running');
  expect(after.tasks[0]!.nodes.map(node => node.id)).toEqual(['work', 'check']);
  expect(after.accepted.map(item => item.proposalVersion)).toEqual([2]);
  expect(after.proposalHistory.map(item => ({ version: item.version, accepted: item.accepted, stale: item.stale }))).toEqual([
    { version: 1, accepted: false, stale: true },
    { version: 2, accepted: true, stale: true },
  ]);
  expect((await runtime.conversations.proposal(created.conversationId, 2)).stale).toBe(true);
  // The old draft is stale after the requirement advanced.
  expect((await runtime.conversations.view(created.conversationId)).proposal?.stale).toBe(true);
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm-again' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  // The feature task is visible as a normal task; the anchor is not.
  expect((await runtime.user.list()).map(task => task.id)).toEqual([confirmed.taskId]);
});

test('post-confirmation chat keeps the requirement fixed and sees real execution status', async () => {
  const root = await temp('post');
  const project = join(root, 'project');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'check.js'), 'console.log("ok");\n');
  const seen: Operation[] = [];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    actions: {
      master: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { text: '继续交流' }, usage }; }),
      work: scripted(() => ({ outcome: 'completed', output: { built: true }, usage })),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '先做最小可用版', requestId: 'create' });
  await runtime.host.runReady();
  const conversation = await runtime.conversations.view(created.conversationId);
  await runtime.supervisor(conversation.anchorTaskId).propose({
    requirementVersion: 1, summary: '最小可用版',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  }, 'proposal');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
  await runtime.conversations.chat(created.conversationId, { text: '现在卡在哪里？', requestId: 'ask' });
  seen.length = 0;
  await runtime.host.runReady();
  expect(seen).toHaveLength(1);
  const briefing = seen[0]!.context.briefing ?? '';
  expect(briefing).toContain('现在卡在哪里？');
  expect(briefing).toContain(confirmed.taskId.slice(0, 8));
  expect(briefing).toContain('Feature task');
  expect(briefing).toContain('work:');
  expect((await runtime.conversations.view(created.conversationId)).requirementVersion).toBe(2);
});

test('a pre-send failure returns the message to the queue instead of losing it', async () => {
  const root = await temp('requeue');
  let attempts = 0;
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: {
      kind: 'agent', reserveTokens: 100,
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('adapter exploded before dispatch');
        return async () => ({ outcome: 'completed', output: { text: '第二次成功' }, usage });
      },
    } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '不要丢消息', requestId: 'create' });
  await runtime.host.runReady();
  const blocked = await runtime.conversations.view(created.conversationId);
  expect(blocked.master?.status).toBe('pending');
  expect(blocked.messages.find(message => message.role === 'user')!.state).toBe('pending');
  // The conversation master owns this execution problem and retries it itself.
  const problems = await runtime.supervisor(blocked.anchorTaskId).listProblems() as { id: string; kind: string }[];
  expect(problems.map(problem => problem.kind)).toEqual(['adapter_error']);
  await runtime.supervisor(blocked.anchorTaskId).resolveProblem({
    questionId: problems[0]!.id,
    action: 'retry',
    requestId: 'retry',
  });
  await runtime.host.runReady();
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.find(message => message.role === 'user')!.state).toBe('delivered');
  expect(after.messages.find(message => message.role === 'assistant')?.text).toBe('第二次成功');
});

test('an uncertain master turn leaves a plain-language notice and a new message retries it', async () => {
  const root = await temp('interrupted');
  let attempts = 0;
  const runtime = await withRuntime(root, async () => {
    attempts += 1;
    if (attempts === 1) throw new SyntaxError('Unterminated string in JSON at position 64472 (line 1 column 64473)');
    return { outcome: 'completed', output: { text: '第二次成功' }, usage };
  });
  const created = await runtime.conversations.create({ text: '你好', requestId: 'create' });
  await runtime.host.runReady();
  const interrupted = await runtime.conversations.view(created.conversationId);
  const notice = interrupted.messages.find(message => message.kind === 'error');
  // The user gets an actionable sentence, never the raw parse error.
  expect(notice?.text).toContain('输出被截断');
  expect(notice?.text ?? '').not.toContain('SyntaxError');
  expect(interrupted.master?.status).toBe('pending');
  const problems = await runtime.supervisor(interrupted.anchorTaskId).listProblems() as { id: string; kind: string }[];
  expect(problems.map(problem => problem.kind)).toEqual(['recovery']);
  // A new user message is an explicit retry and releases the parked master.
  await runtime.conversations.chat(created.conversationId, { text: '再试一次', requestId: 'retry' });
  await runtime.host.runReady();
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.find(message => message.role === 'assistant')?.text).toBe('第二次成功');
});

test('a restart keeps a parked master parked until a configuration change revives it', async () => {
  const root = await temp('parked-restart');
  let firstRuns = 0;
  let secondRuns = 0;
  const first = await withRuntime(root, async () => {
    firstRuns += 1;
    throw new Error('adapter exploded before dispatch');
  });
  const created = await first.conversations.create({ text: 'hi', requestId: 'create' });
  await first.host.runReady();
  const view = await first.conversations.view(created.conversationId);
  expect(await first.supervisor(view.anchorTaskId).listProblems()).toHaveLength(1);
  await first.close();

  // Startup recovery must not replay a deterministic failure forever.
  const second = await withRuntime(root, async () => {
    secondRuns += 1;
    return { outcome: 'completed', output: { text: '配置变更后成功' }, usage };
  });
  const reopened = await second.conversations.view(created.conversationId);
  expect(reopened.master?.status).toBe('pending');
  expect(await second.supervisor(reopened.anchorTaskId).listProblems()).toHaveLength(1);
  expect(secondRuns).toBe(0);

  // A real configuration apply clears the parked problem and retries.
  second.host.recoverMasters();
  await second.host.runReady();
  const after = await second.conversations.view(created.conversationId);
  expect(after.messages.find(message => message.role === 'assistant')?.text).toBe('配置变更后成功');
  expect(await second.supervisor(reopened.anchorTaskId).listProblems()).toHaveLength(0);
  expect(firstRuns).toBe(1);
  expect(secondRuns).toBe(1);
});

async function openTaskRuntimeQuestions(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, taskId: string) {
  return runtime.user.task(taskId).view().then(view => view.questions.filter(question => question.status === 'open'));
}

test('queued messages survive a restart and are answered once', async () => {
  const root = await temp('restart');
  const first = await withRuntime(root, () => ({ outcome: 'completed', output: { text: '不该在第一段运行' }, usage }));
  const created = await first.conversations.create({ text: '重启前的消息', requestId: 'create' });
  await first.close();
  const seen: Operation[] = [];
  const second = await withRuntime(root, operation => { seen.push(operation); return { outcome: 'completed', output: { text: '重启后回答' }, usage }; });
  await second.host.runReady();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.messages?.map(message => message.text)).toEqual(['重启前的消息']);
  const view = await second.conversations.view(created.conversationId);
  expect(view.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  // A second drive must not re-send the same message.
  expect((await second.host.runReady()).dispatched).toBe(0);
});

test('chat request ids are idempotent and bound to their content', async () => {
  const root = await temp('idempotent');
  const runtime = await withRuntime(root, () => ({ outcome: 'completed', output: { text: 'ok' }, usage }));
  const created = await runtime.conversations.create({ text: '第一次', requestId: 'create' });
  await runtime.conversations.chat(created.conversationId, { text: '重复消息', requestId: 'same' });
  await runtime.conversations.chat(created.conversationId, { text: '重复消息', requestId: 'same' });
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.filter(message => message.text === '重复消息')).toHaveLength(1);
  await expect(runtime.conversations.chat(created.conversationId, { text: '不同内容', requestId: 'same' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('unknown master usage on an unlimited conversation completes without a blocking question', async () => {
  const root = await temp('unknown');
  const runtime = await withRuntime(root, () => ({ outcome: 'completed', output: { text: '答复已产生但用量未知' }, usage: null }));
  const created = await runtime.conversations.create({ text: '会未知用量吗', requestId: 'create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.find(message => message.role === 'assistant')?.text).toBe('答复已产生但用量未知');
  const anchorTask = await runtime.user.task(view.anchorTaskId).view();
  expect(anchorTask.questions.some(item => item.kind === 'unknown_usage')).toBe(false);
  expect(anchorTask.nodes.find(node => node.role === 'master')).toMatchObject({ status: 'succeeded', used: 0, unlimited: true });
  expect(view.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
});

test('a scope change after confirmation becomes a new queued task, not an edit of the running one', async () => {
  const root = await temp('new-task');
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    actions: {
      master: scripted(() => ({ outcome: 'completed', output: { text: '这会是一个新任务。' }, usage })),
      work: scripted(() => ({ outcome: 'completed', output: { done: true }, usage })),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '先做第一版', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  const proposal = (summary: string, requirementVersion: number) => ({
    requirementVersion, summary,
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  });
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版', 1), 'draft-1');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const first = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm-1' });
  const firstTask = await runtime.user.task(first.taskId).view();
  expect(firstTask.phase).toBe('running');

  // The user changes the goal while the first task runs.
  await runtime.conversations.chat(created.conversationId, { text: '顺便加上另一平台。', requestId: 'scope' });
  await runtime.host.runReady();
  await runtime.supervisor(anchorTaskId).propose(proposal('另一平台', 2), 'draft-2');
  const second = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm-2' });
  expect(second.taskId).not.toBe(first.taskId);
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.tasks.map(task => task.id)).toEqual([first.taskId, second.taskId]);
  expect(view.tasks.map(task => task.phase)).toEqual(['running', 'queued']);
  // The running task keeps its confirmed acceptance scope.
  const unchanged = await runtime.user.task(first.taskId).view();
  expect(unchanged.acceptedProposalVersion).toBe(1);
  expect(unchanged.proposal?.acceptance.map(item => item.description)).toEqual(['检查通过']);
  expect(unchanged.phase).toBe('running');
  expect(view.requirementVersion).toBe(3);
});

test('a conversation created without models gets its master once dispatch is available', async () => {
  const root = await temp('view-mode');
  const first = await withRuntime(root, () => ({ outcome: 'completed', output: { text: 'never runs' }, usage }), false);
  const created = await first.conversations.create({ text: '仅查看模式下的消息', requestId: 'create' });
  const before = await first.conversations.view(created.conversationId);
  expect(before.master).toBeNull();
  expect(before.messages.find(message => message.role === 'user')!.state).toBe('pending');
  await first.close();

  const seen: Operation[] = [];
  const second = await withRuntime(root, operation => { seen.push(operation); return { outcome: 'completed', output: { text: '恢复后的主管答复' }, usage }; });
  await second.host.runReady();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.messages?.map(message => message.text)).toEqual(['仅查看模式下的消息']);
  const after = await second.conversations.view(created.conversationId);
  expect(after.master?.status).toBe('succeeded');
  expect(after.messages.find(message => message.role === 'assistant')?.text).toBe('恢复后的主管答复');
});

test('unknown master usage does not block a queued conversation turn', async () => {
  const root = await temp('unknown-queued');
  let calls = 0;
  const runtime = await withRuntime(root, () => {
    calls += 1;
    if (calls === 1) return { outcome: 'completed', output: { text: '第一次回答' }, usage: null };
    return { outcome: 'completed', output: { text: '第二次回答' }, usage };
  });
  const created = await runtime.conversations.create({ text: '第一条', requestId: 'create' });
  await runtime.host.runReady();
  const first = await runtime.conversations.view(created.conversationId);
  expect(first.master?.status).toBe('succeeded');
  expect(first.questions.some(item => item.kind === 'unknown_usage')).toBe(false);
  await runtime.conversations.chat(created.conversationId, { text: '第二条', requestId: 'queue' });
  await runtime.host.runReady();
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['第一次回答', '第二次回答']);
  expect(after.messages.find(message => message.text === '第二条')?.state).toBe('delivered');
  expect(calls).toBe(2);
});

test('rebinding a conversation invalidates drafts investigated for the previous project', async () => {
  const root = await temp('rebind');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'a'), { recursive: true });
  await mkdir(join(root, 'b'), { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'a', root: join(root, 'a') }, { id: 'b', root: join(root, 'b') }],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ projectId: 'a', text: '只改进 A', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  const draft = (version: number, summary: string) => ({
    requirementVersion: version, summary,
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  });
  await runtime.supervisor(anchorTaskId).propose(draft(1, '来自 A 的草稿'), 'draft-a');
  const rebound = await runtime.conversations.bind(created.conversationId, { projectId: 'b', requestId: 'rebind' });
  expect(rebound).toMatchObject({ invalidatedDrafts: true });
  const afterBind = await runtime.conversations.view(created.conversationId);
  expect(afterBind.projectId).toBe('b');
  expect(afterBind.requirementVersion).toBe(2);
  expect(afterBind.proposal?.stale).toBe(true);
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm-old' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  // A draft made after the rebind can be confirmed for the new project.
  await runtime.supervisor(anchorTaskId).propose(draft(2, '来自 B 的草稿'), 'draft-b');
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm-new' });
  expect((await runtime.user.task(confirmed.taskId).view()).projectId).toBe('b');
});

test('the default message page shows the newest records and older history stays reachable', async () => {
  const root = await temp('paging');
  const runtime = await withRuntime(root, () => ({ outcome: 'completed', output: { text: 'ok' }, usage }));
  const created = await runtime.conversations.create({ text: 'message-000', requestId: 'create' });
  for (let index = 1; index <= 201; index++) {
    await runtime.conversations.chat(created.conversationId, { text: `message-${String(index).padStart(3, '0')}`, requestId: `msg-${index}` });
  }
  const page = await runtime.conversations.view(created.conversationId);
  expect(page.messageCount).toBe(202);
  expect(page.messages).toHaveLength(200);
  expect(page.messages[0]!.text).toBe('message-002');
  expect(page.messages.at(-1)!.text).toBe('message-201');
  const older = await runtime.conversations.view(created.conversationId, { before: page.messages[0]!.seq });
  expect(older.messages.map(message => message.text)).toEqual(['message-000', 'message-001']);
  const forward = await runtime.conversations.view(created.conversationId, { after: page.messages.at(-1)!.seq });
  expect(forward.messages).toEqual([]);
});

test('a confirmed task carries the conversation decisions and constraints to its workers', async () => {
  const root = await temp('digest');
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  const seen: Operation[] = [];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    actions: {
      master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })),
      work: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { done: true }, usage }; }),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '约束：预算有限，登录先不改。', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.supervisor(anchorTaskId).propose({
    requirementVersion: 1, summary: '最小可用版',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  }, 'draft');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
  await runtime.host.runReady();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.briefing).toContain('Decisions and constraints from the conversation');
  expect(seen[0]!.context.briefing).toContain('预算有限，登录先不改');
});

test('decision snapshots are frozen with the draft and scoped to the project binding', async () => {
  const proposalOf = (requirementVersion: number, summary: string, decisions?: string[]) => ({
    requirementVersion, summary, ...(decisions ? { decisions } : {}),
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  });
  const { mkdir } = await import('node:fs/promises');

  // A constraint from project A must never reach the worker of a B draft.
  {
    const root = await temp('choices-binding');
    await mkdir(join(root, 'a'), { recursive: true });
    await mkdir(join(root, 'b'), { recursive: true });
    const seen: Operation[] = [];
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'a', root: join(root, 'a') }, { id: 'b', root: join(root, 'b') }],
      actions: {
        master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })),
        work: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { done: true }, usage }; }),
      },
      master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    });
    cleanup.push(() => runtime.close());
    const created = await runtime.conversations.create({ projectId: 'a', text: 'A_ONLY: 必须保留 A 的数据库结构。', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, 'Only A maintenance'), 'draft-a');
    await runtime.conversations.bind(created.conversationId, { projectId: 'b', requestId: 'rebind' });
    await runtime.supervisor(anchor).propose(proposalOf(2, 'Only B CSS colors'), 'draft-b');
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.runReady();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.context.briefing).not.toContain('A_ONLY');
  }

  // An early constraint survives later discussion in the same binding.
  {
    const root = await temp('choices-long');
    await mkdir(join(root, 'a'), { recursive: true });
    const seen: Operation[] = [];
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'a', root: join(root, 'a') }],
      actions: {
        master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })),
        work: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { done: true }, usage }; }),
      },
      master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    });
    cleanup.push(() => runtime.close());
    const created = await runtime.conversations.create({ projectId: 'a', text: 'PERSISTENT_CONSTRAINT: 永远不要改 login.ts。', requestId: 'create' });
    await runtime.host.runReady();
    for (let index = 0; index < 10; index++) {
      await runtime.conversations.chat(created.conversationId, { text: `讨论实现细节 ${index}`, requestId: `chat-${index}` });
      await runtime.host.runReady();
    }
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, '改进仪表盘'), 'draft');
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.runReady();
    expect(seen[0]!.context.briefing).toContain('PERSISTENT_CONSTRAINT');
  }

  // Pending chat that arrived after the draft is proposed stays out of the
  // frozen snapshot and is visible as unreviewed on the draft card.
  {
    const root = await temp('choices-after-draft');
    await mkdir(join(root, 'a'), { recursive: true });
    const seen: Operation[] = [];
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'a', root: join(root, 'a') }],
      actions: {
        master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })),
        work: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { done: true }, usage }; }),
      },
      master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    });
    cleanup.push(() => runtime.close());
    const created = await runtime.conversations.create({ projectId: 'a', text: '只调整颜色，保留登录逻辑。', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, 'Only adjust colors'), 'draft');
    await runtime.conversations.chat(created.conversationId, { text: 'UNREVIEWED_NEXT_TASK: 之后还想替换登录和结算，等这个任务之后再讨论。', requestId: 'after' });
    const draft = await runtime.conversations.view(created.conversationId);
    expect(draft.messages.at(-1)!.state).toBe('pending');
    expect(draft.proposal?.decisions).not.toContain('UNREVIEWED_NEXT_TASK');
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.runReady();
    expect(seen[0]!.context.briefing).not.toContain('UNREVIEWED_NEXT_TASK');
  }

  // Master-authored decisions are frozen verbatim and shown on the card.
  {
    const root = await temp('choices-curated');
    await mkdir(join(root, 'a'), { recursive: true });
    const seen: Operation[] = [];
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'a', root: join(root, 'a') }],
      actions: {
        master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })),
        work: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { done: true }, usage }; }),
      },
      master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    });
    cleanup.push(() => runtime.close());
    const created = await runtime.conversations.create({ projectId: 'a', text: '原始聊天文本不应直接当作决策。', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, 'Curated', ['不要修改 login.ts']), 'draft');
    const draft = await runtime.conversations.view(created.conversationId);
    expect(draft.proposal?.decisions).toBe('- 不要修改 login.ts');
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.runReady();
    expect(seen[0]!.context.briefing).toContain('不要修改 login.ts');
    expect(seen[0]!.context.briefing).not.toContain('原始聊天文本不应直接当作决策');
  }
});

test('an explicit empty decisions list revokes constraints without falling back to chat', async () => {
  const root = await temp('choices-empty');
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  const seen: Operation[] = [];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    actions: {
      master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })),
      work: scripted(operation => { seen.push(operation); return { outcome: 'completed', output: { done: true }, usage }; }),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const draftOf = (requirementVersion: number, version: number, decisions?: string[]) => ({
    requirementVersion, summary: `draft-${version}`, ...(decisions ? { decisions } : {}),
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
    ],
  });
  const created = await runtime.conversations.create({ projectId: 'p', text: 'OLD_CONSTRAINT: 永远不要修改 login.ts。', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.supervisor(anchor).propose(draftOf(1, 1, ['不要修改 login.ts']), 'draft-1');
  await runtime.conversations.chat(created.conversationId, { text: '撤销该约束；修订后的提案没有绑定约束。', requestId: 'revoke' });
  await runtime.host.runReady();
  await runtime.supervisor(anchor).propose(draftOf(1, 2, []), 'draft-2');
  const drafted = await runtime.conversations.view(created.conversationId);
  expect(drafted.proposal?.version).toBe(2);
  expect(drafted.proposal?.decisions).toBe('');
  await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm' });
  await runtime.host.runReady();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.briefing).not.toContain('OLD_CONSTRAINT');
  expect(seen[0]!.context.briefing).not.toContain('不要修改 login.ts');
  // A later feature in the same conversation that declares no constraints
  // freezes its own empty snapshot instead of inheriting the previous task's.
  await runtime.supervisor(anchor).propose(draftOf(2, 3, []), 'draft-3');
  const second = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 3, targetBranch: 'main', requestId: 'confirm-2' });
  expect((await runtime.user.task(second.taskId).view()).request).toBe('draft-3');
  expect((await runtime.conversations.view(created.conversationId)).proposal?.decisions).toBe('');
});

test('message state changes are published so incremental caches stay in sync', async () => {
  const root = await temp('message-state');
  let prepareFails = false;
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: {
      kind: 'agent', reserveTokens: 100,
      prepare: async operation => {
        if (prepareFails) throw new Error('adapter exploded before dispatch');
        return async () => ({ outcome: 'completed', output: { text: 'ok' }, usage });
      },
    } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: 'state message', requestId: 'create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  const messageId = view.messages.find(message => message.role === 'user')!.id;
  const updates = (id: string) => runtime.conversations.events(created.conversationId)
    .filter(event => event.type === 'message.updated')
    .map(event => (event.data as { message?: { id?: string; state?: string } }).message)
    .filter(message => message?.id === id)
    .map(message => message!.state);
  expect(updates(messageId)).toContain('delivered');

  // A pre-send failure returns the message to pending and publishes that too.
  prepareFails = true;
  await runtime.conversations.chat(created.conversationId, { text: '再试一次', requestId: 'chat-2' });
  await runtime.host.runReady();
  const retried = await runtime.conversations.view(created.conversationId);
  const retriedId = retried.messages.find(message => message.text === '再试一次')!.id;
  expect(retried.messages.find(message => message.id === retriedId)!.state).toBe('pending');
  expect(updates(retriedId)).toContain('pending');
});
