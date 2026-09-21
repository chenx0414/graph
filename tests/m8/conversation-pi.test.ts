import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { PI_NATIVE_TOOL_NAMES } from '../../src/runtime/pi-native-tools.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-conv-pi-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const proposal = {
  requirementVersion: 1, summary: '最小可用版',
  acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
  nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
    { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
  ],
};

/** Deterministic local provider: a master that investigates once, drafts once,
 * then answers from its briefing; workers always finish. */
async function conversationProvider() {
  const requests: { tools: string[]; messages: { role?: string; content?: unknown }[] }[] = [];
  let listed = false;
  let drafted = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] } : {};
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    requests.push({ tools, messages: body.messages ?? [] });
    const isMaster = tools.includes('propose_graph');
    // A new prompt ends with the user briefing; tool follow-ups end with a tool
    // result, which the persistent session also keeps in older history.
    const isNewPrompt = (body.messages ?? []).at(-1)?.role === 'user';
    const usage = { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const end = (finish: string) => {
      chunk({}, finish);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    if (!isMaster) {
      chunk({ role: 'assistant', content: 'worker finished' }, null);
      end('stop');
      return;
    }
    if (!isNewPrompt) {
      const text = drafted ? '草稿已经生成，等待你确认。' : '本轮完成';
      chunk({ role: 'assistant', content: text }, null);
      end('stop');
      return;
    }
    if (!listed) {
      listed = true;
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-ls', type: 'function', function: { name: 'ls', arguments: JSON.stringify({ path: '.' }) } }] }, null);
      end('tool_calls');
      return;
    }
    if (!drafted) {
      drafted = true;
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-propose', type: 'function', function: { name: 'propose_graph', arguments: JSON.stringify({ proposalJson: JSON.stringify(proposal), requestId: 'master-draft' }) } }] }, null);
      end('tool_calls');
      return;
    }
    chunk({ role: 'assistant', content: '当前 work 节点还在执行准备中，check 尚未运行。' }, null);
    end('stop');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model<'openai-completions'> = {
    id: 'local', name: 'Local', provider: 'local', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('local', { baseUrl, api: 'openai-completions', apiKey: 'local-key', models: [model] });
  return { baseUrl, modelRuntime, requests };
}

async function systemContextProvider() {
  const requests: { tools: string[]; messages: { role?: string; content?: unknown }[] }[] = [];
  let step = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] } : {};
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    requests.push({ tools, messages: body.messages ?? [] });
    const usage = { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const end = (finish: string) => {
      chunk({}, finish);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    const call = (id: string, name: string, args: Record<string, unknown>) => {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
      end('tool_calls');
    };
    step += 1;
    if (step === 1) return call('c1', 'read_system_capabilities', {});
    if (step === 2) return call('c2', 'list_agent_combinations', { query: '审查' });
    if (step === 3) return call('c3', 'search_resources', { query: 'reviewer', kind: 'prompt', role: 'agent' });
    if (step === 4) return call('c4', 'request_model_access', { modelId: 'missing-model', reason: '需要独立审查模型', planId: 'opencode-go' });
    chunk({ role: 'assistant', content: '已打开模型授权问题。' }, null);
    end('stop');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model<'openai-completions'> = {
    id: 'local', name: 'Local', provider: 'local', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('local', { baseUrl, api: 'openai-completions', apiKey: 'local-key', models: [model] });
  return { modelRuntime, requests, baseUrl };
}

test('the real Pi master investigates, drafts, and keeps answering after confirmation', async () => {
  const root = await temp('flow');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Conversation project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);

  const provider = await conversationProvider();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{ id: 'local', provider: 'local', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'c' }],
      apiKey: 'local-key', modelRuntime: provider.modelRuntime,
      credentialFor: () => ({ credentialId: 'c', apiKey: 'local-key' }),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');

  // 1. Chat before any project or task exists.
  const created = await runtime.conversations.create({ text: '这个项目很乱，先帮我看看。', requestId: 'create' });
  await runtime.host.runReady();
  let view = await runtime.conversations.view(created.conversationId);
  expect(view.projectId).toBeNull();
  expect(view.messages.map(message => message.role)).toContain('tool');
  expect(view.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('本轮完成');
  expect(view.tasks).toEqual([]);

  // 2. Bind the project, discuss, and let the master draft.
  await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
  await runtime.conversations.chat(created.conversationId, { text: '就用这个项目，先做最小可用版。', requestId: 'chat' });
  await runtime.host.runReady();
  view = await runtime.conversations.view(created.conversationId);
  expect(view.proposal?.version).toBe(1);
  expect(view.proposal?.spec.summary).toBe('最小可用版');
  expect(view.tasks).toEqual([]);
  expect(view.messages.some(message => message.role === 'system' && message.kind === 'project')).toBe(true);
  expect(view.messages.some(message => message.role === 'assistant' && message.text === '草稿已经生成，等待你确认。')).toBe(true);

  // 3. Confirm and keep talking while the feature task exists.
  const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
  await runtime.conversations.chat(created.conversationId, { text: '现在卡在哪里？', requestId: 'ask' });
  await runtime.host.runReady();
  view = await runtime.conversations.view(created.conversationId);
  expect(view.tasks.map(task => task.id)).toEqual([confirmed.taskId]);
  expect(view.messages.some(message => message.role === 'system' && message.kind === 'confirmed')).toBe(true);
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('work 节点');

  // Read-only discussion: master requests must never expose write tools.
  const masterRequests = provider.requests.filter(request => request.tools.includes('propose_graph'));
  expect(masterRequests.length).toBeGreaterThanOrEqual(3);
  for (const request of masterRequests) {
    expect(request.tools).toEqual(expect.arrayContaining([...PI_NATIVE_TOOL_NAMES]));
    expect(request.tools).not.toContain('write_file');
    expect(request.tools).not.toContain('run_command');
    expect(request.tools).not.toContain('suggest_prompt');
  }
  expect(JSON.stringify(masterRequests[0]!.messages)).not.toContain('ongoing conversation');
  expect(JSON.stringify(masterRequests[0]!.messages)).not.toContain('<workflow>');
  // The post-confirmation briefing carries recorded execution facts.
  const statusRequest = provider.requests.find(request => JSON.stringify(request.messages).includes('现在卡在哪里？'));
  expect(statusRequest).toBeTruthy();
  const statusPrompt = JSON.stringify(statusRequest!.messages);
  expect(statusPrompt).toContain('Feature task');
  expect(statusPrompt).toContain(confirmed.taskId.slice(0, 8));
  expect(statusPrompt).toContain('work:pending');
  // Workers keep their write tools.
  const workerRequests = provider.requests.filter(request => request.tools.includes('submit_result') && !request.tools.includes('propose_graph'));
  expect(workerRequests.length).toBeGreaterThan(0);
  for (const request of workerRequests) {
    expect(request.tools).toEqual(expect.arrayContaining([...PI_NATIVE_TOOL_NAMES]));
  }

  // Streaming and tool activity are on the conversation stream; the durable
  // messages stay the authoritative record.
  const events = runtime.conversations.events(created.conversationId);
  expect(events.some(event => event.type === 'message.delta')).toBe(true);
  const delta = events.find(event => event.type === 'message.delta');
  expect(delta?.data).toMatchObject({
    entryId: expect.any(String),
    partId: 'text',
    len: expect.any(Number),
    reset: true,
  });
  expect(events.some(event => event.type === 'message.tool' && (event.data as { phase?: string }).phase === 'start')).toBe(true);
  expect(view.messages.some(message => message.role === 'tool' && message.text.includes('ls'))).toBe(true);
  expect(view.streams).toEqual([]);
}, 120_000);

test('the real Pi master can search the resource library and open a model-access question', async () => {
  const root = await temp('system-context');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const reviewer = join(capabilityRoot, 'reviewer');
  await mkdir(reviewer, { recursive: true });
  await writeFile(join(reviewer, 'agent.md'), 'Review code independently.\n');
  await writeFile(join(reviewer, 'capability.json'), JSON.stringify({ id: 'reviewer', kind: 'prompt', role: 'agent', version: '1.0.0', name: '代码审查员', description: '审查代码修改' }));
  await writeFile(join(root, 'graph', 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'review', name: '代码审查', description: '组合代码审查身份。', recommendedGrade: 'high', review: true, tags: ['审查'],
      resources: [{ resourceId: 'reviewer', version: '1.0.0', role: 'identity', required: true }],
    }],
  }));

  const provider = await systemContextProvider();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{ id: 'local', provider: 'local', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'c' }],
      apiKey: 'local-key',
      modelRuntime: provider.modelRuntime,
      credentialFor: () => ({ credentialId: 'c', apiKey: 'local-key' }),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
    systemContext: {
      systemSummary: () => ({ configuredModels: [{ id: 'local', grade: 'high' }], subscriptionPlans: [] }),
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  runtime.catalog.publishDefinition('retired', { recommendedGrade: 'medium' }, 'retired');
  runtime.catalog.compileAgentCombination('review');

  const created = await runtime.conversations.create({ projectId: 'p', text: '请先检查可用能力，再决定任务图。', requestId: 'system-context-create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);

  expect(provider.requests[0]!.tools).toEqual(expect.arrayContaining([
    'search_resources', 'get_resource', 'list_agent_combinations', 'get_agent_combination',
    'save_agent_combination', 'compile_agent_combination', 'read_system_capabilities', 'inspect_graph_system',
    'propose_system_change', 'apply_system_change', 'request_model_access',
  ]));
  expect(JSON.stringify(provider.requests[0]!.messages)).toContain('System context');
  expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain('Graph system self-model');
  expect(provider.requests.some(request => {
    const messages = JSON.stringify(request.messages);
    return messages.includes('reviewer') && messages.includes('1.0.0');
  })).toBe(true);
  const briefingContext = JSON.stringify(provider.requests.flatMap(request => request.messages));
  expect(briefingContext).toContain('review@1');
  expect(briefingContext).not.toContain('retired@1');
  expect(view.questions).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'waiting',
      status: 'open',
      data: expect.objectContaining({
        requestType: 'model_access',
        modelId: 'missing-model',
        planId: 'opencode-go',
      }),
    }),
  ]));
}, 120_000);

test('the Main Agent recipe compiles its capabilities into the conversation master bundle', async () => {
  const root = await temp('main-recipe');
  const project = join(root, 'project');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'main-research');
  await mkdir(project, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Main research\n\nInvestigate before proposing a graph.\n');
  await writeFile(join(skill, 'capability.json'), JSON.stringify({
    id: 'main-research',
    kind: 'skill',
    version: '1.0.0',
    name: 'Main Agent Research',
  }, null, 2));
  const recipesPath = join(root, 'graph', 'agent-combinations.json');
  await writeFile(recipesPath, JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main',
      name: 'Main Agent',
      description: 'Main Agent with an extra research capability.',
      mode: 'main',
      recommendedGrade: 'high',
      review: false,
      tags: ['main'],
      resources: [{ resourceId: 'main-research', version: '1.0.0', role: 'skill', required: true }],
    }],
  }, null, 2));
  const provider = await openaiServer([{ text: 'Main Agent recipe loaded.' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    models: {
      entries: [{
        id: 'local',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: () => 'main@1', model: 'local' },
    catalog: {
      capabilityRoot,
      recipesPath,
      bootstrapPrompts: { main: '# Main Agent identity\n\nPlan and orchestrate.' },
      bootstrapToolPrompt: '# Capability awareness',
    },
  });
  cleanup.push(() => runtime.close());
  expect(runtime.catalog.compileAgentCombination('main').definitionVersion).toBe('main@1');
  const created = await runtime.conversations.create({ text: '请先调研再规划。', requestId: 'main-recipe-create' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.master?.definitionVersion).toBe('main@1');
  const request = JSON.stringify(provider.requests[0]);
  expect(request).toContain('Main Agent identity');
  expect(request).toContain('main-research');
  expect(request).toContain('SKILL.md');
});

test('a separate low-grade model creates the composer suggestion from isolated context', async () => {
  const root = await temp('isolated-suggestion');
  const mainProvider = await openaiServer([{ text: '这是正常的最终回答。' }]);
  const suggestionProvider = await openaiServer([{ text: '“继续检查测试覆盖和失败分支。”' }]);
  cleanup.push(() => mainProvider.close());
  cleanup.push(() => suggestionProvider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: {
      entries: [
        {
          id: 'main-model', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
          baseUrl: mainProvider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
        },
        {
          id: 'suggestion-model', provider: 'graph-openai', grade: 'low', api: 'openai-completions',
          baseUrl: suggestionProvider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
        },
      ],
      credentialFor: entry => ({
        credentialId: entry.id,
        apiKey: entry.id === 'main-model' ? 'main-key' : 'suggestion-key',
      }),
      modelRuntime: mainProvider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '你能做什么？', requestId: 'isolated-suggestion' });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  const assistant = view.messages.find(message => message.role === 'assistant')!;
  expect(assistant.text).toBe('这是正常的最终回答。');
  expect((assistant.data as { suggestedPrompt?: unknown } | null)?.suggestedPrompt)
    .toBe('继续检查测试覆盖和失败分支。');

  expect(mainProvider.requests).toHaveLength(1);
  expect(JSON.stringify(mainProvider.requests[0])).not.toContain('suggest_prompt');
  expect(suggestionProvider.requests).toHaveLength(1);
  const suggestionRequest = JSON.stringify(suggestionProvider.requests[0]);
  expect(suggestionRequest).toContain('你能做什么？');
  expect(suggestionRequest).toContain('这是正常的最终回答。');
  expect(suggestionRequest).not.toContain('propose_graph creates a draft');
  expect(suggestionRequest).not.toContain('Feature tasks:');
}, 120_000);

test('editable prompt files and Main Agent tool selection apply to the next operation', async () => {
  const root = await temp('context-overrides');
  const provider = await openaiServer([{ text: 'ok' }]);
  cleanup.push(() => provider.close());
  const agentContext = openAgentContextLibrary(join(root, 'prompts'), { identity: 'Default identity' });
  await agentContext.ensure();
  await agentContext.savePrompt('agents/main.md', 'MAIN IDENTITY SENTINEL');
  await agentContext.savePrompt('runtime/main-conversation.md', 'CONVERSATION SENTINEL {{fullAccessInstruction}}');
  await agentContext.setDisabledTools(['ls', 'write']);

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      credentialFor: () => ({ credentialId: 'local', apiKey: 'scripted-local-key' }),
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    agentContext,
  });
  cleanup.push(() => runtime.close());
  await runtime.conversations.create({ text: '测试可编辑上下文', requestId: 'editable-context' });
  await runtime.host.runReady();

  const request = provider.requests[0] as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] };
  const toolNames = (request.tools ?? []).map(tool => tool.function?.name ?? '');
  expect(toolNames).not.toContain('ls');
  expect(toolNames).not.toContain('write');
  const providerRequest = JSON.stringify(request);
  const user = JSON.stringify((request.messages ?? []).filter(message => message.role === 'user'));
  expect(providerRequest).toContain('<identity>');
  expect(providerRequest).toContain('MAIN IDENTITY SENTINEL');
  expect(providerRequest).toContain('<tools>');
  expect(providerRequest).toContain('- read: Read file contents');
  expect(providerRequest).toContain('following Graph tools for');
  expect(providerRequest).not.toContain('- ls:');
  expect(providerRequest).not.toContain('- write:');
  expect(providerRequest).toContain('<rules>');
  expect(providerRequest).not.toContain('<workflow>');
  expect(providerRequest).not.toContain('CONVERSATION SENTINEL');
  expect(providerRequest).toContain('<docs>');
  expect(providerRequest).toContain('<project_context>');
  expect(providerRequest).toContain('<capabilities>');
  expect(providerRequest).toContain('<cwd>');
  expect(providerRequest).toContain('Current working directory:');
  expect(user).not.toContain('CONVERSATION SENTINEL');
}, 120_000);
