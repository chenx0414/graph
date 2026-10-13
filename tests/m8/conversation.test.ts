import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPresets } from '../../src/catalog/presets.ts';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { NativeProposal, ActionAdapter, Operation, OperationResult } from '../../src/core/types.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

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

// A hand-authored interface workflow for draft/confirmation contracts. Nothing
// executes until the main agent delivers to work.job; check is a host module.
function workflowDraft(requirementVersion: number, summary: string): NativeProposal {
  return { requirementVersion, summary,
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'm', task: summary, inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
      edges: { checked: { from: 'work.result', to: 'check.job', enabled: true } },
      acceptance: [{ id: 'works', description: '检查通过', kind: 'check', module: 'check' }] }) };
}

async function nativeWorkerRuntime(root: string, projects: { id: string; root: string }[], onMaster?: (operation: Operation) => void) {
  const provider = await openaiServer([
    { tools: [{ id: 'result', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: {} } } }) }] },
    { text: 'Work submitted.' },
  ]);
  cleanup.push(() => provider.close());
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects, access: () => fullAccessPolicy(),
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    actions: { master: scripted(operation => { onMaster?.(operation); return { outcome: 'completed', output: { text: 'ok' }, usage }; }) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'm', provider: provider.model.provider,
      grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const runWorker = async (graphId: string) => {
    await runtime.supervisor(graphId).graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
    await runtime.host.drive();
    expect(runtime.nodeRun(graphId, 'work').node.status).toBe('succeeded');
    expect(provider.requests).toHaveLength(2);
    return JSON.stringify(provider.requests[0]);
  };
  return { runtime, runWorker };
}

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

test('compact is a durable conversation command carried into the next master operation', async () => {
  const root = await temp('compact-command');
  const seen: Operation[] = [];
  const runtime = await withRuntime(root, operation => {
    seen.push(operation);
    return { outcome: 'completed', output: { text: 'ok' }, usage };
  });
  const created = await runtime.conversations.create({ text: '先讨论', requestId: 'compact-create' });
  await runtime.host.runReady();
  seen.length = 0;

  const receipt = await runtime.conversations.compact(created.conversationId, { requestId: 'compact-command' });
  expect(receipt).toMatchObject({ state: 'pending', pending: false });
  await runtime.host.runReady();

  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.messages).toEqual([
    expect.objectContaining({ text: '压缩当前会话上下文', command: 'compact' }),
  ]);
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.at(-2)).toMatchObject({
    role: 'user',
    text: '压缩当前会话上下文',
    data: { command: 'compact' },
  });
});

test('the master briefing includes Agent recipe descriptions for subagent selection', async () => {
  const root = await temp('agent-recipe-description');
  const capabilityRoot = join(root, 'capabilities');
  const identity = join(capabilityRoot, 'agent-md', 'coder-identity');
  await mkdir(identity, { recursive: true });
  await writeFile(join(identity, 'capability.json'), JSON.stringify({
    id: 'coder-identity',
    kind: 'prompt',
    role: 'agent',
    version: '1.0.0',
    name: 'Coder identity',
  }));
  await writeFile(join(identity, 'agent.md'), 'You are a coder.\n');
  const seen: Operation[] = [];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: scripted(operation => {
      seen.push(operation);
      return { outcome: 'completed', output: { text: 'ok' }, usage };
    }) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    catalog: { capabilityRoot, recipesPath: join(root, 'agent-combinations.json') },
  });
  cleanup.push(() => runtime.close());
  await runtime.catalog.saveAgentCombination({
    id: 'coder',
    name: 'Bob_coder',
    description: '默认主实现，承担功能开发、维护、修复和基础测试。',
    recommendedGrade: 'medium',
    review: false,
    tags: ['编码'],
    resources: [{ resourceId: 'coder-identity', version: '1.0.0', role: 'identity', required: true }],
  });
  const created = await runtime.conversations.create({ text: '选择实现 Agent。', requestId: 'recipe-description-create' });
  await runtime.host.runReady();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.briefing).toContain('Agent recipe coder (Bob_coder, medium, valid): 默认主实现，承担功能开发、维护、修复和基础测试。');
  await runtime.conversations.view(created.conversationId);
});

test('Main Agent can validate a graph, inspect its state, list projects and bind a project', async () => {
  const root = await temp('graph-state');
  const projectOne = join(root, 'project-one');
  const projectTwo = join(root, 'project-two');
  await mkdir(projectOne);
  await mkdir(projectTwo);
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [
      { id: 'one', root: projectOne },
      { id: 'two', root: projectTwo },
    ],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '调查项目。', requestId: 'graph-state-create' });
  const conversation = await runtime.conversations.view(created.conversationId);
  const supervisor = runtime.supervisor(conversation.anchorTaskId);

  const state = await supervisor.graphState() as {
    phase: string;
    proposalVersion: number;
    graph: unknown;
    relatedTasks: unknown[];
    nodes: unknown[];
    evidence: unknown[];
  };
  expect(state).toMatchObject({
    phase: 'chatting',
    proposalVersion: 0,
    graph: null,
    relatedTasks: [],
    nodes: [expect.objectContaining({ id: 'master', role: 'master', status: 'pending' })],
    evidence: [],
  });

  const projects = await supervisor.listProjects() as { id: string; preparation: unknown }[];
  expect(projects.map(project => project.id)).toEqual(['one', 'two']);
  expect(projects.every(project => 'preparation' in project)).toBe(true);

  const validProposal = workflowDraft(conversation.requirementVersion, 'Validate only.');
  await expect(supervisor.validateProposal({
    ...validProposal,
    acceptance: [{ id: 'a1', description: 'Passes.', checkNode: 'missing' }],
  })).rejects.toMatchObject({ code: 'invalid_proposal' });
  await expect(supervisor.validateProposal(validProposal)).resolves.toEqual({
    valid: true,
    requirementVersion: conversation.requirementVersion,
  });
  const inconsistent: ((draft: NativeProposal) => void)[] = [
    draft => { delete draft.definition.acceptance; },
    draft => { draft.acceptance[0]!.description = 'A different user-visible requirement'; },
    draft => { draft.acceptance[0]!.checkNode = 'work'; },
    draft => { draft.definition.acceptance![0] = { id: 'works', description: '检查通过', kind: 'review', node: 'work' }; },
    draft => { draft.acceptance[0]!.id = 'another-requirement'; },
    draft => { draft.definition.acceptance!.push({ id: 'hidden', description: 'Undisclosed manual approval', kind: 'human' }); },
  ];
  for (const [index, change] of inconsistent.entries()) {
    const draft = structuredClone(validProposal); change(draft);
    await expect(supervisor.validateProposal(draft)).rejects.toMatchObject({ code: 'invalid_proposal' });
    await expect(supervisor.propose(draft, `inconsistent-${index}`)).rejects.toMatchObject({ code: 'invalid_proposal' });
    expect((await runtime.conversations.view(created.conversationId)).proposal).toBeNull();
  }


  await runtime.projects.prepare({ projectId: 'one', requestId: 'prepare-one' });
  const bound = await supervisor.bindProject({ projectId: 'one', requestId: 'bind-one' });
  expect(bound).toMatchObject({ changed: true });
  expect((await runtime.conversations.view(created.conversationId)).projectId).toBe('one');
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

test('an archived conversation does not occupy a chatting lane', async () => {
  const root = await temp('archive-lane');
  const seen: Operation[] = [];
  const runtime = await withRuntime(root, operation => {
    seen.push(operation);
    return { outcome: 'completed', output: { text: 'ok' }, usage };
  });
  const created = await runtime.conversations.create({ text: '先归档', requestId: 'archive-lane-create' });
  await runtime.conversations.archive(created.conversationId, 'archive-lane');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(seen).toHaveLength(0);
  await runtime.conversations.unarchive(created.conversationId, 'archive-lane-restore');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(seen).toHaveLength(1);
});

test('full access does not retry a chatting master with an empty queue', async () => {
  const root = await temp('full-access-empty-queue');
  let attempts = 0;
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    access: () => fullAccessPolicy(),
    actions: { master: scripted(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('uncertain after dispatch');
      return { outcome: 'completed', output: { text: '恢复成功' }, usage };
    }) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '你好', requestId: 'create' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(attempts).toBe(1);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(attempts).toBe(1);
  expect((await runtime.user.task(created.taskId).view()).questions).toMatchObject([{ kind: 'recovery', owner: 'main', status: 'open' }]);
  await runtime.conversations.chat(created.conversationId, { text: '再试一次', requestId: 'retry' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(attempts).toBe(2);
  expect((await runtime.conversations.view(created.conversationId)).messages.at(-1)?.text).toBe('恢复成功');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
});

test('full access preserves an explicit continuation after the chat message was consumed', async () => {
  const root = await temp('full-access-continuation');
  const seen: Operation[] = [];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    access: () => fullAccessPolicy(),
    actions: { master: scripted(operation => {
      seen.push(operation);
      return seen.length === 1
        ? { outcome: 'continue', output: { text: '继续处理' }, usage }
        : { outcome: 'completed', output: { text: '处理完成' }, usage };
    }) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '请处理', requestId: 'create' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(seen[1]!.context.messages ?? []).toEqual([]);
  expect((await runtime.conversations.view(created.conversationId)).messages.at(-1)?.text).toBe('处理完成');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
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
  // Thinking is always on and no default is configured, so the shared rule (the
  // second strongest of Pi's default levels) decides.
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm1', thinkingLevel: 'medium' });

  const selected = await runtime.conversations.selectModel(created.conversationId, {
    model: 'm2', thinkingLevel: 'high', requestId: 'model-select',
  });
  expect(selected).toMatchObject({ model: 'm2', thinkingLevel: 'high', changed: true });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm2', thinkingLevel: 'high' });

  // The legacy reasoning flag no longer turns thinking off: every model keeps a
  // real level, so switching back to m1 keeps the requested one.
  const clamped = await runtime.conversations.selectModel(created.conversationId, {
    model: 'm1', thinkingLevel: 'high', requestId: 'model-select-clamped',
  });
  expect(clamped).toMatchObject({ model: 'm1', thinkingLevel: 'high' });
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({ model: 'm1', thinkingLevel: 'high' });
});

test('an output-limit turn settles with a retry notice instead of staying in progress', async () => {
  const root = await temp('output-limit');
  const provider = await openaiServer([{
    thinking: 'This reasoning consumed the entire output budget. '.repeat(200),
    finishReason: 'length',
    usage: {
      prompt_tokens: 128,
      completion_tokens: 256,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 256 },
    },
  }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{
        id: 'local',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
        reasoning: true,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');

  const created = await runtime.conversations.create({ text: '这个问题需要很长的思考。', requestId: 'output-limit-create' });
  await runtime.host.runReady();

  const view = await runtime.conversations.view(created.conversationId);
  const notice = view.messages.find(message => message.role === 'system' && message.kind === 'error');
  expect(notice?.text).toContain('输出被截断');
  expect(view.master?.status).not.toBe('dispatched');
}, 30_000);

test('a tool-use response that keeps SSE open does not stall the following turn', async () => {
  const root = await temp('tool-use-output-limit');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const images = ['1.png', '2.png', '3.png', '4.png'].map(name => join(project, name));
  for (const image of images) await writeFile(image, Buffer.alloc(512 * 1024, 7));
  const provider = await openaiServer([
    {
      finishReason: 'tool_calls',
      tools: images.map((image, index) => ({
        id: `read-image-${index}`,
        name: 'read',
        arguments: JSON.stringify({ path: image }),
      })),
    },
    { text: 'First reply.' },
    {
      thinking: 'I will publish the plan without supplying its content. '.repeat(100),
      finishReason: 'tool_calls',
      tools: [{
        id: 'publish-without-content',
        name: 'artifact_publish',
        arguments: JSON.stringify({
          namespace: 'plans',
          name: 'truncated-plan',
          requestId: 'truncated-plan-1',
        }),
      }],
      usage: {
        prompt_tokens: 128,
        completion_tokens: 256,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 256 },
      },
      holdOpen: true,
    },
    { text: 'The publish error was handled.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{
        id: 'local',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
        reasoning: true,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');

  const created = await runtime.conversations.create({ projectId: 'p', text: '开始。', requestId: 'tool-limit-create' });
  await runtime.host.runReady();
  await runtime.conversations.chat(created.conversationId, { text: '继续，按推荐处理。', requestId: 'tool-limit-follow-up' });
  await runtime.host.runReady();

  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('publish error was handled');
  expect(view.master?.status).not.toBe('dispatched');
}, 30_000);

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
  // The synthetic provider is not in the catalog, so only Pi's default levels
  // are available and the configured xhigh falls back to the strongest of them.
  expect((await runtime.conversations.view(created.conversationId)).telemetry).toMatchObject({
    model: 'm-default',
    thinkingLevel: 'high',
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

test('settings offer only currently configured models, not removed history', async () => {
  const root = await temp('stale-models');
  const options = {
    stateDir: join(root, 'state'),
    actions: { master: scripted(() => ({ outcome: 'completed' as const, output: { text: 'ok' }, usage })) },
    models: {
      entries: [{
        id: 'live', provider: 'synthetic', grade: 'high' as const, api: 'openai-completions' as const,
        baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: true,
      }],
      modelRuntime: {} as never,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'live' },
  };
  const first = await openTaskRuntime(options);
  expect(first.models().map(model => model.id)).toEqual(['live']);
  await first.close();
  // Simulate a model that used to be configured and was later removed: its
  // durable row remains for old task records but must not be offered again.
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  db.prepare('INSERT OR REPLACE INTO models VALUES(?,?)').run('removed', JSON.stringify({ provider: 'synthetic', grade: 'low' }));
  db.close();
  const reopened = await openTaskRuntime(options);
  cleanup.push(() => reopened.close());
  expect(reopened.models().map(model => model.id)).toEqual(['live']);
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

test('explicit newVersion keeps draft history and only the latest can be confirmed', async () => {
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

  const proposal = (summary: string) => workflowDraft(1, summary);
  await runtime.supervisor(anchorTaskId).propose(proposal('旧方案'), 'proposal-1');
  // Version history is now opt-in: without newVersion the current draft is edited in place.
  await runtime.supervisor(anchorTaskId).propose(proposal('新方案'), 'proposal-2', { newVersion: true });
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
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-old' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-new' });
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.requirementVersion).toBe(2);
  expect(after.tasks).toHaveLength(1);
  expect(after.tasks[0]!.id).toBe(confirmed.taskId);
  expect(after.tasks[0]!.phase).toBe('running');
  expect(after.tasks[0]!.nodes.map(node => node.id)).toEqual(['work']);
  expect(after.tasks[0]!.nodes[0]!.status).toBe('idle');
  expect(runtime.kernelGraph(confirmed.taskId)).toMatchObject({ revision: 1, definition: {
    modules: { check: { type: 'operation', operation: { action: 'workspace.command' } } },
    edges: { checked: { from: 'work.result', to: 'check.job', enabled: true } },
  } });
  const queued = await runtime.supervisor(anchorTaskId).graphInspect({ graphId: confirmed.taskId, query: 'queue' }) as { items: unknown[] };
  expect(queued.items).toEqual([]);
  expect(after.accepted.map(item => item.proposalVersion)).toEqual([2]);
  expect(after.proposalHistory.map(item => ({ version: item.version, accepted: item.accepted, stale: item.stale }))).toEqual([
    { version: 1, accepted: false, stale: true },
    { version: 2, accepted: true, stale: true },
  ]);
  expect((await runtime.conversations.proposal(created.conversationId, 2)).stale).toBe(true);
  // The old draft is stale after the requirement advanced.
  expect((await runtime.conversations.view(created.conversationId)).proposal?.stale).toBe(true);
  const graphState = await runtime.supervisor(anchorTaskId).graphState() as {
    relatedTasks: { taskId: string; graphVersion: number; nodes: { id: string }[] }[];
  };
  expect(graphState.relatedTasks).toEqual([
    expect.objectContaining({
      taskId: confirmed.taskId,
      graphVersion: 1,
      nodes: [expect.objectContaining({ id: 'work', origin: 'v2', status: 'idle' })],
    }),
  ]);
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-again' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  // The feature task is visible as a normal task; the anchor is not.
  expect((await runtime.user.list()).map(task => task.id)).toEqual([confirmed.taskId]);
});

// The draft-lifecycle contract: editing a draft in place must not pile up versions,
// a credential taken from replaced content must never confirm the replacement, and
// archive/delete are per-version tombstones that leave a started graph untouched.
async function draftFixture(name: string) {
  const root = await temp(name);
  const project = join(root, 'project');
  const second = join(root, 'second');
  await mkdir(project, { recursive: true });
  await mkdir(second, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }, { id: 'q', root: second }],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'draft ready' }, usage })) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '做一个最小可用版', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  return { runtime, conversationId: created.conversationId, anchorTaskId, proposal: (summary: string) => workflowDraft(1, summary) };
}

test('editing a draft in place replaces its content without stacking versions', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('in-place');
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版'), 'p1');
  const first = await runtime.conversations.view(conversationId);
  expect(first.proposal?.version).toBe(1);
  const firstRevision = first.proposal!.draftRevision;
  expect(typeof firstRevision).toBe('number');
  const firstDigest = first.proposal!.draftDigest;

  await runtime.supervisor(anchorTaskId).propose(proposal('改过的方案'), 'p2');
  const edited = await runtime.conversations.view(conversationId);
  // Same version, same draft identity, new content and a new credential.
  expect(edited.proposal?.version).toBe(1);
  expect(edited.proposal?.spec.summary).toBe('改过的方案');
  expect(edited.proposal!.draftRevision).toBeGreaterThan(firstRevision);
  expect(edited.proposal!.draftDigest).not.toBe(firstDigest);
  expect(edited.proposalHistory.map(item => item.version)).toEqual([1]);
  expect((await runtime.conversations.proposal(conversationId, 1)).spec.summary).toBe('改过的方案');
});

test('a confirmation credential from replaced draft content is refused', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('stale-credential');
  await runtime.supervisor(anchorTaskId).propose(proposal('原始内容'), 'p1');
  const stale = (await runtime.conversations.view(conversationId)).proposal!.draftRevision;
  await runtime.supervisor(anchorTaskId).propose(proposal('被替换的内容'), 'p2');
  await expect(runtime.conversations.confirm(conversationId, {
    proposalVersion: 1, draftRevision: stale, targetBranch: 'main', requestId: 'confirm-stale',
  })).rejects.toMatchObject({ code: 'stale_proposal' });
  const current = await runtime.conversations.view(conversationId);
  const confirmed = await runtime.conversations.confirm(conversationId, {
    proposalVersion: 1, draftRevision: current.proposal!.draftRevision, targetBranch: 'main', requestId: 'confirm-current',
  });
  expect(confirmed.taskId).toBeTruthy();
  const after = await runtime.conversations.view(conversationId);
  expect(after.tasks).toHaveLength(1);
  expect(after.tasks[0]!.id).toBe(confirmed.taskId);
  // The acceptance records the exact content that was confirmed, not just a version.
  expect(after.accepted.map(item => ({ version: item.proposalVersion, revision: item.draftRevision })))
    .toEqual([{ version: 1, revision: current.proposal!.draftRevision }]);
});

test('archive hides a draft from the active list and restore brings it back', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('archive');
  await runtime.supervisor(anchorTaskId).propose(proposal('待归档方案'), 'p1');
  await runtime.conversations.archiveDraft(conversationId, { proposalVersion: 1, requestId: 'archive-1' });
  const archived = await runtime.conversations.view(conversationId);
  expect(archived.proposal).toBeNull();
  // Archiving is not deletion: the content is still readable by version, and the
  // card is gone from the active list rather than flagged in it.
  expect(archived.proposalHistory).toEqual([]);
  expect(archived.archivedProposals.map(item => item.version)).toEqual([1]);
  const mainView = await runtime.supervisor(anchorTaskId).graphState();
  expect(mainView.proposal).toBeNull();
  expect(mainView.archivedProposals?.map(item => item.version)).toEqual([1]);
  expect((await runtime.user.task(anchorTaskId).view()).proposal).toBeNull();
  // Archiving is not deletion: the content is still readable by version.
  expect((await runtime.conversations.proposal(conversationId, 1)).spec.summary).toBe('待归档方案');
  await expect(runtime.conversations.confirm(conversationId, {
    proposalVersion: 1, draftRevision: archived.archivedProposals[0]!.draftRevision, targetBranch: 'main', requestId: 'confirm-archived',
  })).rejects.toMatchObject({ code: 'stale_proposal' });

  await runtime.conversations.restoreDraft(conversationId, { proposalVersion: 1, requestId: 'restore-1' });
  const restored = await runtime.conversations.view(conversationId);
  expect(restored.proposal?.version).toBe(1);
  expect(restored.proposal?.spec.summary).toBe('待归档方案');
  expect(restored.archivedProposals).toEqual([]);
});

test('deleting a draft hides it but never removes the graph it started', async () => {
  const root = await temp('delete');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  // A real Pi run (work -> check) so there is real evidence, a real session and a
  // real graph revision that deletion is forbidden to touch.
  const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'p', root: project }]);
  const created = await runtime.conversations.create({ text: '做一个最小可用版', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  await runtime.supervisor(anchorTaskId).propose(workflowDraft(1, '会被确认的方案'), 'p1');
  const current = await runtime.conversations.view(created.conversationId);
  const confirmed = await runtime.conversations.confirm(created.conversationId, {
    proposalVersion: 1, draftRevision: current.proposal!.draftRevision, targetBranch: 'main', requestId: 'confirm-1',
  });
  const taskId = confirmed.taskId;
  const session = await runWorker(taskId);
  const before = await runtime.conversations.view(created.conversationId);
  const messagesBefore = before.messages.length;
  // The run itself: node entries, the graph's acceptance record and the proposal
  // copy the confirmed task owns.
  const entriesBefore = runtime.nodeRun(taskId, 'work').entries.length;
  const acceptanceBefore = (await runtime.supervisor(anchorTaskId).graphInspect({ graphId: taskId, query: 'acceptance' }) as { items: unknown[] }).items.length;
  expect(entriesBefore).toBeGreaterThan(0);
  expect(acceptanceBefore).toBeGreaterThan(0);

  // The confirmed card can be cleared out of the draft lists, and doing so must not
  // touch the started graph, its chat, its evidence or the frozen acceptance.
  await runtime.conversations.deleteDraft(created.conversationId, { proposalVersion: 1, requestId: 'delete-1' });
  const after = await runtime.conversations.view(created.conversationId);
  expect(after.proposal).toBeNull();
  expect(after.proposalHistory).toEqual([]);
  expect(after.archivedProposals).toEqual([]);
  await expect(runtime.conversations.proposal(created.conversationId, 1)).rejects.toMatchObject({ code: 'not_found' });
  expect(after.messages.length).toBe(messagesBefore);
  expect(after.tasks.map(task => task.id)).toEqual([taskId]);
  expect(after.tasks[0]!.acceptedProposalVersion).toBe(1);
  expect(runtime.nodeRun(taskId, 'work').entries.length).toBe(entriesBefore);
  expect((await runtime.supervisor(anchorTaskId).graphInspect({ graphId: taskId, query: 'acceptance' }) as { items: unknown[] }).items.length).toBe(acceptanceBefore);
  expect((await runtime.user.list()).map(task => task.id)).toEqual([taskId]);
  expect(runtime.kernelGraph(taskId)).toMatchObject({ revision: 1, definition: { nodes: { work: expect.anything() } } });
  expect(runtime.nodeRun(taskId, 'work').node.status).toBe('succeeded');
  expect(session).toContain('work');
});

test('a confirmed draft is never overwritten by a later task or a rebinding', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('immutable-after-confirm');
  await runtime.supervisor(anchorTaskId).propose(proposal('会被确认的方案'), 'p1');
  const before = await runtime.conversations.view(conversationId);
  const confirmed = await runtime.conversations.confirm(conversationId, {
    proposalVersion: 1, draftRevision: before.proposal!.draftRevision, targetBranch: 'main', requestId: 'confirm-1',
  });
  // Confirmation advances the anchor requirement, so the confirmed card can no
  // longer be edited in place: the next draft is a new version.
  expect((await runtime.conversations.view(conversationId)).requirementVersion).toBe(2);
  await runtime.supervisor(anchorTaskId).propose(workflowDraft(2, '第二个方案'), 'p2');
  expect((await runtime.conversations.view(conversationId)).proposal?.version).toBe(2);
  expect((await runtime.conversations.proposal(conversationId, 1)).spec.summary).toBe('会被确认的方案');
  expect(runtime.kernelGraph(confirmed.taskId)).toMatchObject({ revision: 1, definition: { nodes: { work: expect.anything() } } });

  // Rebinding the conversation to another project invalidates drafts the same way.
  await runtime.conversations.bind(conversationId, { projectId: 'q', requestId: 'rebind' });
  expect((await runtime.conversations.view(conversationId)).requirementVersion).toBe(3);
  await runtime.supervisor(anchorTaskId).propose(workflowDraft(3, '第三个方案'), 'p3');
  expect((await runtime.conversations.view(conversationId)).proposal?.version).toBe(3);
  expect((await runtime.conversations.proposal(conversationId, 2)).spec.summary).toBe('第二个方案');
  expect((await runtime.conversations.proposal(conversationId, 1)).spec.summary).toBe('会被确认的方案');
});

test('a deleted or archived version is never handed out again', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('tombstone-high-water');
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版'), 'p1');
  await runtime.supervisor(anchorTaskId).propose(proposal('第二版'), 'p2', { newVersion: true });
  await runtime.conversations.archiveDraft(conversationId, { proposalVersion: 2, requestId: 'archive-2' });
  await runtime.conversations.restoreDraft(conversationId, { proposalVersion: 1, requestId: 'restore-1' });
  // The archived v2 still holds its number, so the next explicit version is 3.
  await runtime.supervisor(anchorTaskId).propose(proposal('第三版'), 'p3', { newVersion: true });
  const view = await runtime.conversations.view(conversationId);
  expect(view.proposal?.version).toBe(3);
  expect(view.proposalHistory.map(item => item.version)).toEqual([1, 3]);
  expect(view.archivedProposals.map(item => item.version)).toEqual([2]);
  // Archiving is not deletion: the archived content is still readable by version.
  expect((await runtime.conversations.proposal(conversationId, 2)).spec.summary).toBe('第二版');
  // A delete leaves a tombstone, so the version after it is still fresh ground.
  await runtime.conversations.deleteDraft(conversationId, { proposalVersion: 3, requestId: 'delete-3' });
  await runtime.supervisor(anchorTaskId).propose(proposal('第四版'), 'p4', { newVersion: true });
  const later = await runtime.conversations.view(conversationId);
  expect(later.proposal?.version).toBe(4);
  expect(later.proposalHistory.map(item => item.version)).toEqual([1, 4]);
});

test('a deleted draft version is never handed out again', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('high-water');
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版'), 'p1');
  await runtime.conversations.deleteDraft(conversationId, { proposalVersion: 1, requestId: 'delete-1' });
  await runtime.supervisor(anchorTaskId).propose(proposal('删除之后的新草稿'), 'p2');
  const view = await runtime.conversations.view(conversationId);
  expect(view.proposal?.version).toBe(2);
  expect(view.proposal?.spec.summary).toBe('删除之后的新草稿');
  expect(view.proposalHistory.map(item => item.version)).toEqual([2]);
});

test('restoring an archived draft makes it current again without stacking versions', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('restore-current');
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版'), 'p1');
  await runtime.supervisor(anchorTaskId).propose(proposal('第二版'), 'p2', { newVersion: true });
  await runtime.conversations.archiveDraft(conversationId, { proposalVersion: 1, requestId: 'archive-1' });
  await runtime.conversations.archiveDraft(conversationId, { proposalVersion: 2, requestId: 'archive-2' });
  const archived = await runtime.conversations.view(conversationId);
  expect(archived.proposal).toBeNull();
  expect(archived.proposalHistory).toEqual([]);
  expect(archived.archivedProposals.map(item => item.version)).toEqual([1, 2]);
  // An explicit by-version read still shows archived content, marked archived.
  expect((await runtime.conversations.proposal(conversationId, 1)).spec.summary).toBe('第一版');
  expect((await runtime.conversations.proposal(conversationId, 1)).archived).toBe(true);

  await runtime.conversations.restoreDraft(conversationId, { proposalVersion: 1, requestId: 'restore-1' });
  const restored = await runtime.conversations.view(conversationId);
  // Restored v1 is the current draft again, so a default edit stays on v1 instead
  // of piling up another version.
  expect(restored.proposal?.version).toBe(1);
  expect(restored.proposal?.spec.summary).toBe('第一版');
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版改过'), 'p3');
  const edited = await runtime.conversations.view(conversationId);
  expect(edited.proposal?.version).toBe(1);
  expect(edited.proposal?.spec.summary).toBe('第一版改过');
  expect(edited.proposal!.draftRevision).toBe(2);
  expect(edited.proposalHistory.map(item => item.version)).toEqual([1]);
  // The archived v2 is still archived and still holds its number.
  expect(edited.archivedProposals.map(item => item.version)).toEqual([2]);
  await runtime.supervisor(anchorTaskId).propose(proposal('第三版'), 'p4', { newVersion: true });
  const later = await runtime.conversations.view(conversationId);
  expect(later.proposal?.version).toBe(3);
  expect(later.proposalHistory.map(item => item.version)).toEqual([1, 3]);
});

test('a conversation master patches its native feature graph and reads queued status', async () => {
  const root = await temp('revise-feature');
  const project = join(root, 'project'); await mkdir(project);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: '继续交流' }, usage })) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '先做最小可用版', requestId: 'create' });
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  const supervisor = runtime.supervisor(anchorTaskId);
  await supervisor.propose(workflowDraft(1, '最小可用版'), 'proposal');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
  const graphId = confirmed.taskId;
  expect(await supervisor.graphPatch({ graphId, baseRevision: 1, changes: {
    reason: '把下次实现模型换到另一个可用模型', patch: { nodes: { work: { model: 'm2' } } },
  } })).toEqual({ revision: 2 });
  const graphState = await supervisor.graphState() as { relatedTasks: { taskId: string; graphVersion: number; nodes: { id: string }[] }[] };
  expect(graphState.relatedTasks).toEqual([expect.objectContaining({ taskId: graphId, graphVersion: 2,
    nodes: [expect.objectContaining({ id: 'work', origin: 'v2', status: 'idle' })] })]);
  const status = await supervisor.taskStatus({ taskId: graphId }) as { taskId: string; graphVersion: number; nodes: { id: string }[] };
  expect(status).toMatchObject({ taskId: graphId, graphVersion: 2 });
  expect(status.nodes.map(node => node.id)).toEqual(['work']);
  const focused = await supervisor.taskStatus({ taskId: graphId, nodeId: 'work' });
  expect(focused).toMatchObject({ nodes: [{ id: 'work', status: 'idle', kind: 'agent', configuration: {
    model: 'm2', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
  } }] });
  const definition = await supervisor.graphInspect({ graphId, query: 'revision' });
  expect(definition).toMatchObject({ modules: { check: { operation: { action: 'workspace.command', command: 'node', args: ['--version'] } } } });
  expect(await supervisor.taskStatus({ taskId: graphId, waitForNode: 'work', timeoutMs: 0 })).toMatchObject({ reason: 'settled' });
  // Queued input is pending work even before the host starts a Pi process.
  await supervisor.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
  expect(await supervisor.taskStatus({ taskId: graphId, waitForNode: 'work', timeoutMs: 0 })).toMatchObject({ reason: 'timeout' });
  await expect(supervisor.taskStatus({ taskId: graphId, nodeId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(supervisor.taskStatus({ taskId: '0faf1367-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(supervisor.graphPatch({ graphId: '0faf1367-0000-0000-0000-000000000000', baseRevision: 1,
    changes: { reason: '越界', patch: { nodes: {} } } })).rejects.toMatchObject({ code: 'not_found' });
});

test('post-confirmation chat keeps the requirement fixed and sees real execution status', async () => {
  const root = await temp('post');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const seen: Operation[] = [];
  const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'p', root: project }], operation => { seen.push(operation); });
  const created = await runtime.conversations.create({ text: '先做最小可用版', requestId: 'create' });
  await runtime.host.runReady();
  const conversation = await runtime.conversations.view(created.conversationId);
  await runtime.supervisor(conversation.anchorTaskId).propose(workflowDraft(1, '最小可用版'), 'proposal');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
  await runtime.conversations.chat(created.conversationId, { text: '现在卡在哪里？', requestId: 'ask' });
  seen.length = 0;
  await runtime.host.runReady();
  expect(seen).toHaveLength(1);
  const briefing = seen[0]!.context.briefing ?? '';
  expect(briefing).toContain('现在卡在哪里？');
  expect(briefing).toContain(confirmed.taskId.slice(0, 8));
  expect(briefing).toContain('Feature task');
  expect(briefing).toContain('work:idle');
  expect((await runtime.conversations.view(created.conversationId)).requirementVersion).toBe(2);

  // An explicit input runs a real Pi; the next main turn must describe its
  // recorded result rather than the idle status from the confirmation card.
  await runWorker(confirmed.taskId);
  seen.length = 0;
  await runtime.conversations.chat(created.conversationId, { text: '执行完成了吗？', requestId: 'after-work' });
  await runtime.host.runReady();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context.briefing).toContain('执行完成了吗？');
  expect(seen[0]!.context.briefing).toContain('work:succeeded');
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
  // Answering the same problem twice is safe: it reports itself as already settled instead of
  // pretending it never existed (the main Agent may retry a receipt it never saw).
  await expect(runtime.supervisor(blocked.anchorTaskId).resolveProblem({
    questionId: problems[0]!.id,
    action: 'retry',
    requestId: 'retry-again',
  })).resolves.toMatchObject({ questionId: problems[0]!.id, alreadyResolved: true });
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
  expect((await runtime.host.runReady()).dispatched).toBe(0);
  expect(attempts).toBe(1);
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
  expect((await second.host.runReady()).dispatched).toBe(0);
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
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '先做第一版', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  const proposal = (summary: string, requirementVersion: number) => workflowDraft(requirementVersion, summary);
  await runtime.supervisor(anchorTaskId).propose(proposal('第一版', 1), 'draft-1');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const first = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-1' });
  const firstTask = await runtime.user.task(first.taskId).view();
  expect(firstTask.phase).toBe('running');

  // The user changes the goal while the first task runs.
  await runtime.conversations.chat(created.conversationId, { text: '顺便加上另一平台。', requestId: 'scope' });
  await runtime.host.runReady();
  await runtime.supervisor(anchorTaskId).propose(proposal('另一平台', 2), 'draft-2');
  const second = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-2' });
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
  const draft = (version: number, summary: string) => workflowDraft(version, summary);
  await runtime.supervisor(anchorTaskId).propose(draft(1, '来自 A 的草稿'), 'draft-a');
  const rebound = await runtime.conversations.bind(created.conversationId, { projectId: 'b', requestId: 'rebind' });
  expect(rebound).toMatchObject({ invalidatedDrafts: true });
  const afterBind = await runtime.conversations.view(created.conversationId);
  expect(afterBind.projectId).toBe('b');
  expect(afterBind.requirementVersion).toBe(2);
  expect(afterBind.proposal?.stale).toBe(true);
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-old' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  // A draft made after the rebind can be confirmed for the new project.
  await runtime.supervisor(anchorTaskId).propose(draft(2, '来自 B 的草稿'), 'draft-b');
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-new' });
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
  const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'p', root: project }]);
  const created = await runtime.conversations.create({ text: '约束：预算有限，登录先不改。', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.supervisor(anchorTaskId).propose(workflowDraft(1, '最小可用版'), 'draft');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
  const briefing = await runWorker(confirmed.taskId);
  expect(briefing).toContain('Decisions and constraints from the conversation');
  expect(briefing).toContain('预算有限，登录先不改');
});

test('decision snapshots are frozen with the draft and scoped to the project binding', async () => {
  const proposalOf = (requirementVersion: number, summary: string, decisions?: string[]) => ({
    ...workflowDraft(requirementVersion, summary), ...(decisions === undefined ? {} : { decisions }),
  });
  const { mkdir } = await import('node:fs/promises');

  // A constraint from project A must never reach the worker of a B draft.
  {
    const root = await temp('choices-binding');
    await mkdir(join(root, 'a'), { recursive: true });
    await mkdir(join(root, 'b'), { recursive: true });
    const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'a', root: join(root, 'a') }, { id: 'b', root: join(root, 'b') }]);
    const created = await runtime.conversations.create({ projectId: 'a', text: 'A_ONLY: 必须保留 A 的数据库结构。', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, 'Only A maintenance'), 'draft-a');
    await runtime.conversations.bind(created.conversationId, { projectId: 'b', requestId: 'rebind' });
    await runtime.supervisor(anchor).propose(proposalOf(2, 'Only B CSS colors'), 'draft-b');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
    const briefing = await runWorker(confirmed.taskId);
    expect(briefing).not.toContain('A_ONLY');
  }

  // An early constraint survives later discussion in the same binding.
  {
    const root = await temp('choices-long');
    await mkdir(join(root, 'a'), { recursive: true });
    const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'a', root: join(root, 'a') }]);
    const created = await runtime.conversations.create({ projectId: 'a', text: 'PERSISTENT_CONSTRAINT: 永远不要改 login.ts。', requestId: 'create' });
    await runtime.host.runReady();
    for (let index = 0; index < 10; index++) {
      await runtime.conversations.chat(created.conversationId, { text: `讨论实现细节 ${index}`, requestId: `chat-${index}` });
      await runtime.host.runReady();
    }
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, '改进仪表盘'), 'draft');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
    const briefing = await runWorker(confirmed.taskId);
    expect(briefing).toContain('PERSISTENT_CONSTRAINT');
  }

  // Pending chat that arrived after the draft is proposed stays out of the
  // frozen snapshot and is visible as unreviewed on the draft card.
  {
    const root = await temp('choices-after-draft');
    await mkdir(join(root, 'a'), { recursive: true });
    const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'a', root: join(root, 'a') }]);
    const created = await runtime.conversations.create({ projectId: 'a', text: '只调整颜色，保留登录逻辑。', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, 'Only adjust colors'), 'draft');
    await runtime.conversations.chat(created.conversationId, { text: 'UNREVIEWED_NEXT_TASK: 之后还想替换登录和结算，等这个任务之后再讨论。', requestId: 'after' });
    const draft = await runtime.conversations.view(created.conversationId);
    expect(draft.messages.at(-1)!.state).toBe('pending');
    expect(draft.proposal?.decisions).not.toContain('UNREVIEWED_NEXT_TASK');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
    const briefing = await runWorker(confirmed.taskId);
    expect(briefing).toContain('只调整颜色，保留登录逻辑');
    expect(briefing).not.toContain('UNREVIEWED_NEXT_TASK');
  }

  // Master-authored decisions are frozen verbatim and shown on the card.
  {
    const root = await temp('choices-curated');
    await mkdir(join(root, 'a'), { recursive: true });
    const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'a', root: join(root, 'a') }]);
    const created = await runtime.conversations.create({ projectId: 'a', text: '原始聊天文本不应直接当作决策。', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.supervisor(anchor).propose(proposalOf(1, 'Curated', ['不要修改 login.ts']), 'draft');
    const draft = await runtime.conversations.view(created.conversationId);
    expect(draft.proposal?.decisions).toBe('- 不要修改 login.ts');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
    const briefing = await runWorker(confirmed.taskId);
    expect(briefing).toContain('不要修改 login.ts');
    expect(briefing).not.toContain('原始聊天文本不应直接当作决策');
  }
});

test('an explicit empty decisions list revokes constraints without falling back to chat', async () => {
  const root = await temp('choices-empty');
  const project = join(root, 'project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project, { recursive: true });
  const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'p', root: project }]);
  const draftOf = (requirementVersion: number, version: number, decisions?: string[]) => ({
    ...workflowDraft(requirementVersion, `draft-${version}`), ...(decisions === undefined ? {} : { decisions }),
  });
  const created = await runtime.conversations.create({ projectId: 'p', text: 'OLD_CONSTRAINT: 永远不要修改 login.ts。', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.supervisor(anchor).propose(draftOf(1, 1, ['不要修改 login.ts']), 'draft-1');
  await runtime.conversations.chat(created.conversationId, { text: '撤销该约束；修订后的提案没有绑定约束。', requestId: 'revoke' });
  await runtime.host.runReady();
  await runtime.supervisor(anchor).propose(draftOf(1, 2, []), 'draft-2', { newVersion: true });
  const drafted = await runtime.conversations.view(created.conversationId);
  expect(drafted.proposal?.version).toBe(2);
  expect(drafted.proposal?.decisions).toBe('');
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
  const briefing = await runWorker(confirmed.taskId);
  expect(briefing).not.toContain('OLD_CONSTRAINT');
  expect(briefing).not.toContain('不要修改 login.ts');
  // A later feature in the same conversation that declares no constraints
  // freezes its own empty snapshot instead of inheriting the previous task's.
  await runtime.supervisor(anchor).propose(draftOf(2, 3, []), 'draft-3');
  const second = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 3, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-2' });
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

test('a native delivery failure notifies main and the user decision reaches a new explicit input without leaking a defective output', async () => {
  const root = await temp('native-noncompliant'); const project = join(root, 'project'); await mkdir(project);
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const fixed = { objective: 'Escalated handoff', workSummary: 'FIXED_AFTER_ESCALATION' };
  const mainProvider = await openaiServer([{ text: 'Ready to coordinate' }, { text: '交接文档缺少 objective，需要你确认目标表述后再继续。' }, { text: '已记录用户决定。' }]);
  const worker = await openaiServer([
    { tools: [{ id: 'invalid', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { workSummary: 'BROKEN_HANDOFF_SENTINEL' } } } }) }] },
    { text: 'Forgot the required valid result' }, { text: 'Still missing the required result' },
    { tools: [{ id: 'fixed', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: fixed } } }) }] }, { text: 'Fixed after user decision' },
  ]);
  const suggestion = await openaiServer(Array.from({ length: 4 }, () => ({ text: 'none' })));
  const next = await openaiServer([{ text: 'Received the valid handoff' }]);
  for (const provider of [mainProvider, worker, next, suggestion]) cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    master: { action: 'master', definitionVersion: 'main@1', model: 'main' },
    models: { apiKey: 'local-only', modelRuntime: mainProvider.runtime, entries: ([['main', mainProvider], ['worker', worker], ['next', next], ['suggestion', suggestion]] as const).map(([id, provider]) => ({
      id, modelId: id, provider: provider.model.provider, grade: id === 'suggestion' ? 'low' : 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256,
    })) } }); cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, fileURLToPath(new URL('../../presets', import.meta.url)));
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const created = await runtime.conversations.create({ projectId: 'p', text: 'TASK_REQUEST_SENTINEL：实现并交接', requestId: 'create' }); await runtime.host.drive();
  const main = runtime.supervisor(created.taskId); const data = { protocol: 'handoff' };
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Explicit repair',
    protocols: { handoff: { type: 'object', required: ['objective'], properties: { objective: { type: 'string', minLength: 1 }, workSummary: { type: 'string' } } } },
    nodes: { work: { recipe: 'coder@1', model: 'worker', task: 'Submit a valid result satisfying the handoff protocol', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } },
      next: { recipe: 'coder@1', model: 'next', task: 'Read the valid result', inputs: { job: data }, outputs: {}, submission: {} } },
    modules: {}, edges: { handoff: { from: 'work.result', to: 'next.job', enabled: true } },
  }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { objective: 'INITIAL_WORK_OBJECTIVE' } }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'work'); expect(before.node.status).toBe('failed');
  expect(before.operations).toMatchObject([{ state: 'failed', resubmits_used: 1 }]);
  expect(worker.requests).toHaveLength(3); expect(next.requests).toHaveLength(0);
  const refusal = (worker.requests[1] as { messages: { role: string; content: unknown }[] }).messages.filter(message => message.role === 'tool');
  expect(JSON.stringify(refusal)).toContain('output_protocol_mismatch'); expect(JSON.stringify(refusal)).toContain('objective');
  await expect(main.graphInspect({ graphId, query: 'edge', id: 'handoff' })).resolves.toMatchObject({ deliveries: [] });
  expect(mainProvider.requests).toHaveLength(2);
  expect(JSON.stringify(mainProvider.requests[1])).toContain(graphId);
  expect(JSON.stringify(mainProvider.requests[1])).toMatch(/work.*required|Missing required|missing required/i);
  const visible = await runtime.conversations.view(created.conversationId);
  expect(visible.messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(visible.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('需要你确认目标表述');
  const decision = 'USER_DECISION_SENTINEL：目标按交付页描述。';
  await runtime.conversations.chat(created.conversationId, { text: decision, requestId: 'user-decision' }); await runtime.host.drive();
  expect(mainProvider.requests).toHaveLength(3); expect(JSON.stringify(mainProvider.requests[2])).toContain(decision);
  const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
  await main.graphControl({ graphId, action: 'skip', seq: queue.items[0]!.seq });
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { objective: decision, workSummary: 'Repair BROKEN_HANDOFF_SENTINEL' } }); await runtime.host.drive();
  const after = runtime.nodeRun(graphId, 'work'); expect(after.node.status).toBe('succeeded');
  expect(after.instance!.id).toBe(before.instance!.id); expect(after.session!.sessionId).toBe(before.session!.sessionId);
  expect(after.operations).toHaveLength(2); expect(worker.requests).toHaveLength(5); expect(next.requests).toHaveLength(1);
  const newestUser = (worker.requests[3] as { messages: { role: string; content: unknown }[] }).messages.filter(message => message.role === 'user').at(-1);
  expect(JSON.stringify(newestUser)).toContain(decision); expect(JSON.stringify(newestUser)).toContain('BROKEN_HANDOFF_SENTINEL');
  expect(JSON.stringify(newestUser)).not.toContain('TASK_REQUEST_SENTINEL');
  expect(JSON.stringify(next.requests[0])).toContain('FIXED_AFTER_ESCALATION'); expect(JSON.stringify(next.requests[0])).not.toContain('BROKEN_HANDOFF_SENTINEL');
  await expect(main.graphInspect({ graphId, query: 'edge', id: 'handoff' })).resolves.toMatchObject({ deliveries: [{ value: fixed }] });
}, 60000);

test.each(['before_session', 'session_opened', 'model_sent'])('restart resumes only a proven unsent Pi conversation (%s)', async stage => {
  const root = await temp(`restart-${stage}`);
  const provider = await openaiServer([{ text: 'Recovered and answered the original request.' }]);
  cleanup.push(() => provider.close());
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    access: () => fullAccessPolicy(),
    master: { action: 'master', definitionVersion: 'main@1', model: 'local' },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const,
      api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'local-test', modelRuntime: provider.runtime },
  };
  const original = await openTaskRuntime({ ...options, actions: { master: scripted(async () => {
    started();
    return new Promise<OperationResult>(() => undefined);
  }) } });
  cleanup.push(() => original.close());
  await installPresets(original.catalog, fileURLToPath(new URL('../../presets', import.meta.url)));
  const created = await original.conversations.create({ projectId: 'p', text: '查看运行状态', requestId: 'start' });
  await original.host.pump();
  await waiting;
  await original.close();
  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  const operation = db.prepare("SELECT id,instance_id FROM operations WHERE state='dispatched'").get() as { id: string; instance_id: string };
  if (stage === 'session_opened') db.prepare(`INSERT INTO node_capabilities(task_id,node_id,instance_id,operation_id,read_only,loaded,created_at)
    VALUES(?,'master',?,?,0,'[]',1)`).run(created.taskId, operation.instance_id, operation.id);
  if (stage === 'model_sent') db.prepare("INSERT INTO invocations(id,operation_id,instance_id,model) VALUES('sent',?,?,'local')")
    .run(operation.id, operation.instance_id);
  db.close();
  const restored = await openTaskRuntime(options);
  cleanup.push(() => restored.close());
  const dispatch = await restored.host.runReady();
  expect(dispatch.dispatched).toBe(stage === 'before_session' ? 1 : 0);
  const view = await restored.conversations.view(created.conversationId);
  if (stage === 'before_session') {
    expect(view.messages.filter(message => message.role === 'assistant').map(message => message.text))
      .toEqual(['Recovered and answered the original request.']);
    expect(view.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(await restored.host.runReady()).toEqual({ dispatched: 0 });
  } else {
    expect(view.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
    expect(view.questions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'recovery', owner: 'main', status: 'open' })]));
  }
});

test('the master can withdraw its own unconfirmed draft without losing it', async () => {
  const root = await temp('withdraw-draft');
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
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  const draft = {
    requirementVersion: 1, summary: '被取代的方案',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'Minimal implementation', protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'm', task: 'Implement the minimal version', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.js'], output: 'result' } } },
      edges: { checkWork: { from: 'work.result', to: 'check.job', enabled: true } },
      acceptance: [{ id: 'works', description: '检查通过', kind: 'check', module: 'check' }] }),
  };
  await runtime.supervisor(anchorTaskId).propose(draft, 'draft-1');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });

  // Only a draft that exists and is still the current one can be withdrawn.
  await expect(runtime.supervisor(anchorTaskId).withdrawDraft({ proposalVersion: 7, requestId: 'w-none' }))
    .rejects.toMatchObject({ code: 'not_found' });

  const receipt = await runtime.supervisor(anchorTaskId).withdrawDraft({ proposalVersion: 1, reason: '方向已变', requestId: 'w-1' });
  expect(receipt).toMatchObject({ withdrawnVersion: 1, nextProposalVersion: 2 });

  // The user-visible outcome: the draft is gone from the conversation view (the same source the
  // briefing digest reads), its history stays readable, the user is told, and the confirmation
  // entry is refused instead of confirming something that was withdrawn.
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.proposal).toBeNull();
  expect(view.proposalHistory.map(item => item.version)).toContain(1);
  expect(view.messages.some(message => message.role === 'system' && message.text.includes('已作废：方向已变'))).toBe(true);
  await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-withdrawn' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });

  // Withdrawing again is refused, and the next draft keeps a monotonic version: the withdrawn
  // number and the retired one are both skipped, so v1 → v3.
  await expect(runtime.supervisor(anchorTaskId).withdrawDraft({ proposalVersion: 1, requestId: 'w-again' }))
    .rejects.toMatchObject({ code: 'stale_proposal' });
  await runtime.supervisor(anchorTaskId).propose({ ...draft, summary: '新方案' }, 'draft-2');
  expect((await runtime.conversations.view(created.conversationId)).proposal?.version).toBe(3);
});

// The worker needs the confirmed constraints, not the main agent's conversation
// status. Check the real model request so the two contexts cannot be conflated.
test('the conversation status stays with the master while the constraints still reach the workers', async () => {
  const root = await temp('status-scope');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const { runtime, runWorker } = await nativeWorkerRuntime(root, [{ id: 'p', root: project }]);
  const created = await runtime.conversations.create({ text: '约束：预算有限，登录先不改。', requestId: 'create' });
  await runtime.host.runReady();
  const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
  await runtime.supervisor(anchorTaskId).propose(workflowDraft(1, '最小可用版'), 'draft');
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
  const briefing = await runWorker(confirmed.taskId);
  // The constraint the user stated is what this node has to obey.
  expect(briefing).toContain('Decisions and constraints from the conversation');
  expect(briefing).toContain('预算有限，登录先不改');
  // The master's monitoring picture is not this node's business.
  expect(briefing).not.toContain('Conversation and execution status');
});

test('accepting a draft needs the credential of the revision that was reviewed', async () => {
  const { runtime, proposal } = await draftFixture('accept-credential');
  const { taskId: anchorTaskId } = await runtime.user.begin({ projectId: 'p', request: 'Formal feature', requestId: 'begin' });
  await runtime.supervisor(anchorTaskId).propose(proposal('方案一'), 'p1');
  // The credential is discoverable from the formal task view, not only from the
  // database: a caller reads it here and carries it back to accept.
  const view = await runtime.user.task(anchorTaskId).view();
  expect(view.proposalVersion).toBe(1);
  expect(view.draftRevision).toBe(1);
  // An in-place edit keeps the version number but changes the credential.
  await runtime.supervisor(anchorTaskId).propose(proposal('方案一改'), 'p2');
  const edited = await runtime.user.task(anchorTaskId).view();
  expect(edited.proposalVersion).toBe(1);
  expect(edited.draftRevision).toBe(2);
  await expect(runtime.user.task(anchorTaskId).accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept-old' }))
    .rejects.toThrow(/changed after it was reviewed/);
  const receipt = await runtime.user.task(anchorTaskId).accept({ proposalVersion: 1, draftRevision: 2, targetBranch: 'main', requestId: 'accept-new' });
  expect(receipt).toMatchObject({ proposalVersion: 1, draftRevision: 2 });
  // Replaying the same request returns the recorded receipt without applying twice.
  const replay = await runtime.user.task(anchorTaskId).accept({ proposalVersion: 1, draftRevision: 2, targetBranch: 'main', requestId: 'accept-new' });
  expect(replay).toMatchObject({ proposalVersion: 1, draftRevision: 2 });
  expect((await runtime.user.task(anchorTaskId).view()).acceptedProposalVersion).toBe(1);
});

test('draft cards belong to their own conversation and never leak across', async () => {
  const { runtime, conversationId, anchorTaskId, proposal } = await draftFixture('card-isolation');
  const other = await runtime.conversations.create({ text: '另一个会话', requestId: 'other-create' });
  await runtime.host.runReady();
  const otherAnchor = (await runtime.conversations.view(other.conversationId)).anchorTaskId;
  await runtime.conversations.bind(other.conversationId, { projectId: 'p', requestId: 'other-bind' });
  await runtime.supervisor(anchorTaskId).propose(proposal('甲会话草稿'), 'p1');
  await runtime.supervisor(otherAnchor).propose(workflowDraft(1, '乙会话草稿'), 'p2');
  await runtime.conversations.archiveDraft(other.conversationId, { proposalVersion: 1, requestId: 'archive-other' });
  const mine = await runtime.conversations.view(conversationId);
  expect(mine.proposal?.spec.summary).toBe('甲会话草稿');
  expect(mine.archivedProposals).toEqual([]);
  const theirs = await runtime.conversations.view(other.conversationId);
  expect(theirs.proposal).toBeNull();
  expect(theirs.archivedProposals.map(item => item.version)).toEqual([1]);
});


test.each(['resolve', 'reject'])('bounded shutdown preserves an unsent input when adapter preparation later %s', async (outcome) => {
  const root = await temp('late-prepare-close');
  const started = Promise.withResolvers<void>();
  const preparation = Promise.withResolvers<() => Promise<OperationResult>>();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: { kind: 'agent', reserveTokens: 100, prepare: async () => { started.resolve(); return preparation.promise; } } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: 'Preserve the original unsent request.', requestId: 'begin' });
  const running = runtime.host.runReady();
  await started.promise;
  await runtime.close();
  if (outcome === 'reject') preparation.reject(new Error('Late preparation failure'));
  else preparation.resolve(async () => {
    await writeFile(join(root, 'must-not-dispatch.txt'), 'late effect');
    return { outcome: 'completed', output: { text: 'Must not settle after close.' }, usage };
  });
  await running;
  await expect(readFile(join(root, 'must-not-dispatch.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const reopened = await withRuntime(root, () => ({ outcome: 'completed', output: { text: 'New authorized input.' }, usage }));
  const view = await reopened.conversations.view(created.conversationId);
  expect(view.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Preserve the original unsent request.']);
  expect(view.messages.filter(message => message.role === 'assistant')).toEqual([]);
}, 15_000);
