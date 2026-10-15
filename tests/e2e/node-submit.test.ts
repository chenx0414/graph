import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('native submit refusals remain correctable, identical replay is idempotent and a different second submission cannot replace delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-submit-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  let inspectEdge: () => Promise<unknown> = async () => undefined;
  const snapshots: unknown[] = [];
  const outputs = [null, { out: null }, { out: { enable: 'yes' } }, { out: { enable: true, value: { n: 'seven' } } }, { out: { enable: false } },
    { out: { enable: true, value: { n: 7 } } }, { out: { enable: true, value: { n: 7 } } }, { out: { enable: true, value: { n: 8 } } }];
  const plans: ResponsePlan[] = outputs.map((value, index) => ({ tools: [{ id: `submit-${index}`, name: 'submit', arguments: JSON.stringify({ outputs: value }) }],
    beforeReply: async () => { if (index > 0) snapshots.push(await inspectEdge()); } }));
  plans.push({ tools: [{ id: 'unknown-tool', name: 'not_a_tool', arguments: '{}' }], beforeReply: async () => { snapshots.push(await inspectEdge()); } });
  plans.push({ text: 'The original output stands', beforeReply: async () => { snapshots.push(await inspectEdge()); } });
  const sender = await openaiServer(plans); const receiver = await openaiServer([{ text: 'Received exactly the original value' }]); cleanup.push(() => sender.close(), () => receiver.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    limits: { defaultBudgetTokens: 20_000_000 }, models: { apiKey: 'local-only', modelRuntime: sender.runtime,
      entries: Object.entries({ a: sender, b: receiver }).map(([id, provider]) => ({ id, provider: provider.model.provider, grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Correct and replay a native submission', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  const port = { protocol: 'ping' };
  const { graphId } = await main.graphCreate({ definition: { schemaVersion: 2, name: 'Submit correction', protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
    nodes: { a: { recipe: 'worker@1', model: 'a', task: 'Submit the required number', inputs: { job: port }, outputs: { out: port }, submission: { required: ['out'] } },
      b: { recipe: 'worker@1', model: 'b', task: 'Acknowledge the received number', inputs: { in: port }, outputs: {}, submission: {} } },
    modules: {}, edges: { e: { from: 'a.out', to: 'b.in', enabled: true } }, inputs: {}, outputs: { result: { from: 'a.out', protocol: 'ping' } } } }) as { graphId: string };
  inspectEdge = () => main.graphInspect({ graphId, query: 'edge', id: 'e' });
  await main.graphSend({ graphId, nodeId: 'a', input: 'job', value: { n: 0 } }); await runtime.host.drive();
  for (const snapshot of snapshots.slice(0, 5)) expect(snapshot).toMatchObject({ deliveries: [] });
  for (const snapshot of snapshots.slice(5)) expect(snapshot).toMatchObject({ deliveries: [{ value: { n: 7 } }] });
  const lastTool = (index: number) => {
    const body = sender.requests[index] as { messages: { role: string; content: unknown }[] };
    return String(body.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '');
  };
  // Invalid envelopes can be rejected by the real native tool schema before the kernel;
  // both boundaries leave the one valid submission available for the next correction.
  for (const [index, path, defect] of [[1, 'outputs', 'must be object'], [2, 'outputs.out', 'must be object'], [3, 'outputs.out.enable', 'must be boolean']] as const) {
    expect(lastTool(index)).toContain('Validation failed for tool');
    expect(lastTool(index)).toContain('submit');
    expect(lastTool(index)).toContain(path);
    expect(lastTool(index)).toContain(defect);
  }
  expect(lastTool(4)).toContain('out'); expect(lastTool(4)).toContain('expected'); expect(lastTool(4)).toContain('got'); expect(lastTool(4)).toContain('Do not redo');
  expect(lastTool(5)).toContain('missing_required_output'); expect(lastTool(5)).toContain('enable:true');
  for (const index of [6, 7]) {
    // This is the actual hostSubmitCall receipt, observed in the next request
    // sent by the real resident process. No callback supplies accepted or IDs.
    expect(JSON.parse(lastTool(index))).toEqual({ accepted: true, deliveries: 1 });
    const body = sender.requests[index] as { messages: { role: string; tool_call_id?: string }[] };
    expect(body.messages.filter(message => message.role === 'tool').at(-1)?.tool_call_id).toBe(`submit-${index - 1}`);
  }
  expect(lastTool(8)).toContain('already_submitted');
  expect(lastTool(9)).toContain('Tool not_a_tool not found');
  const finalRequest = sender.requests[9] as { messages: { role: string; tool_call_id?: string }[] };
  expect(finalRequest.messages.filter(message => message.role === 'tool').at(-1)?.tool_call_id).toBe('unknown-tool');
  const prompt = sender.requests[0] as { tools: { function: { name: string } }[] };
  expect(prompt.tools.some(tool => tool.function.name === 'submit')).toBe(true);
  expect(prompt.tools.some(tool => tool.function.name === 'not_a_tool')).toBe(false);
  const senderRun = runtime.nodeRun(graphId, 'a');
  expect(senderRun.operations).toHaveLength(1);
  expect(senderRun.operations[0]).toMatchObject({ submission_id: expect.any(String) });
  expect(senderRun.node.status).toBe('succeeded');
  expect(senderRun.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'result', data: expect.objectContaining({ toolName: 'not_a_tool', toolCallId: 'unknown-tool', isError: true }) }),
    expect.objectContaining({ role: 'assistant', kind: 'message', text: 'The original output stands' }),
  ]));
  expect(sender.requests).toHaveLength(10); expect(receiver.requests).toHaveLength(1);
  await expect(main.graphInspect({ graphId, query: 'edge', id: 'e' })).resolves.toMatchObject({ deliveries: [{ value: { n: 7 } }] });
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { n: 7 } }]);
  await expect(main.graphInspect({ graphId, query: 'executions' })).resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ nodeId: 'a', state: 'completed' }), expect.objectContaining({ nodeId: 'b', state: 'completed' })]) });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
}, 60_000);
