import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Answer, Operation, OperationResult } from '../../src/core/types.ts';

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

test('messages sent while the master is running queue into exactly one next turn', async () => {
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
  expect(queued.messages.filter(message => message.role === 'user').map(message => message.state)).toEqual(['delivered', 'pending', 'pending']);
  release();
  await first;
  await runtime.host.runReady();
  expect(seen).toHaveLength(2);
  // The second turn answers both queued messages once, in order.
  expect(seen[1]!.context.messages?.map(message => message.text)).toEqual(['第二条', '第三条']);
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.filter(message => message.role === 'user').every(message => message.state === 'delivered')).toBe(true);
  expect(after.messages.filter(message => message.role === 'assistant')).toHaveLength(2);
  expect(after.messages.filter(message => message.role === 'assistant')[1]!.text).toBe('答：第二条 / 第三条');
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
  expect(blocked.master?.status).toBe('blocked');
  expect(blocked.messages.find(message => message.role === 'user')!.state).toBe('pending');
  // Answer the adapter_error with a retry, as the UI does.
  const questions = await openTaskRuntimeQuestions(runtime, blocked.anchorTaskId);
  expect(questions.map(question => question.kind)).toEqual(['adapter_error']);
  await runtime.user.task(blocked.anchorTaskId).answer(questions[0]!.id, { type: 'retry' } as Answer, 'retry');
  await runtime.host.runReady();
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.messages.find(message => message.role === 'user')!.state).toBe('delivered');
  expect(after.messages.find(message => message.role === 'assistant')?.text).toBe('第二次成功');
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

test('unknown master usage opens the accepted reconciliation path without duplicating the reply', async () => {
  const root = await temp('unknown');
  const runtime = await withRuntime(root, () => ({ outcome: 'completed', output: { text: '答复已产生但用量未知' }, usage: null }));
  const created = await runtime.conversations.create({ text: '会未知用量吗', requestId: 'create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  // The reply stays visible even though the invocation is unmeasured.
  expect(view.messages.find(message => message.role === 'assistant')?.text).toBe('答复已产生但用量未知');
  const anchorTask = await runtime.user.task(view.anchorTaskId).view();
  const question = anchorTask.questions.find(item => item.kind === 'unknown_usage');
  expect(question).toBeTruthy();
  await runtime.user.task(view.anchorTaskId).answer(question!.id, { type: 'usage', usage, proof: '供应商账单' }, 'reconcile');
  const reconciled = await runtime.conversations.view(created.conversationId);
  expect(reconciled.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  const anchorAfter = await runtime.user.task(view.anchorTaskId).view();
  expect(anchorAfter.questions.some(item => item.kind === 'unknown_usage' && item.status === 'open')).toBe(false);
  const master = anchorAfter.nodes.find(node => node.role === 'master');
  expect(master?.used).toBe(15);
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

test('reconciling unknown usage continues the message queued during the blocked turn', async () => {
  for (const type of ['usage', 'reconcile_usage'] as const) {
    const root = await temp(`reconcile-${type}`);
    let calls = 0;
    const runtime = await withRuntime(root, () => {
      calls += 1;
      if (calls === 1) return { outcome: 'completed', output: { text: '第一次回答' }, usage: null };
      return { outcome: 'completed', output: { text: '第二次回答' }, usage };
    });
    const created = await runtime.conversations.create({ text: '第一条', requestId: 'create' });
    await runtime.host.runReady();
    const blocked = await runtime.conversations.view(created.conversationId);
    expect(blocked.master?.status).toBe('blocked');
    const question = blocked.questions.find(item => item.kind === 'unknown_usage' && item.status === 'open');
    expect(question).toBeTruthy();
    await runtime.conversations.chat(created.conversationId, { text: '第二条', requestId: 'queue' });
    await runtime.user.task(blocked.anchorTaskId).answer(question!.id,
      type === 'usage' ? { type: 'usage', usage, proof: '账单' } : { type: 'reconcile_usage', proof: '供应商不提供' }, 'answer');
    await runtime.host.runReady();
    const after = await runtime.conversations.view(created.conversationId);
    expect(after.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['第一次回答', '第二次回答']);
    expect(after.messages.find(message => message.text === '第二条')?.state).toBe('delivered');
    expect(calls).toBe(2);
  }
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
