import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPresets } from '../../src/catalog/presets.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
async function temp(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-conversation-runtime-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// These were already genuine provider/Pi end-to-end workflows in m8's mixed
// file. Preserve their independent contracts under the semantic E2E owner.
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
  let providerClose: Promise<void> | undefined;
  const closeProvider = () => providerClose ??= provider.close();
  cleanup.push(closeProvider);
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
  let deadlineExpired = false;
  // Release the fixture before the test timeout so a broken EOF guard still
  // settles its real invocation while the runtime/store remain alive.
  const deadline = setTimeout(() => { deadlineExpired = true; void closeProvider().catch(() => undefined); }, 20_000);
  try {
    await runtime.host.runReady();
    expect(deadlineExpired, 'Actual held-SSE turn must finish before fixture teardown releases its connection').toBe(false);
    await runtime.conversations.chat(created.conversationId, { text: '继续，按推荐处理。', requestId: 'tool-limit-follow-up' });
    await runtime.host.runReady();
    expect(deadlineExpired, 'Actual held-SSE turn must finish before fixture teardown releases its connection').toBe(false);

    const view = await runtime.conversations.view(created.conversationId);
    expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('publish error was handled');
    expect(view.master?.status).not.toBe('dispatched');
    expect(runtime.nodeRun(created.taskId, 'master').invocations.filter(call => call.usage?.output === 256)).toMatchObject([{
      usageSource: 'authoritative', usage: { input: 128, output: 256, cacheRead: 0, cacheWrite: 0 },
    }]);
  } finally { clearTimeout(deadline); }
}, 30_000);

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
