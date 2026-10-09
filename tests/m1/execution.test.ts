import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { taskGate } from '../../src/runtime/task-gate.ts';
import { fullAccessPolicy, standardAccessPolicy, type AccessPolicy } from '../../src/core/access-policy.ts';
import { RuntimeError, type ActionAdapter } from '../../src/core/types.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('confirmed native output survives restart and reaches a real host check without repeating the Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-delivery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const arrived = deferred<void>(); const finish = deferred<void>();
  const provider = await openaiServer([
    { tools: [{ id: 'publish', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'result', mediaType: 'text/markdown', content: 'Implemented title search', requestId: 'publish-result' }) }] },
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { report: 'Implemented title search' } } } }) }] },
    { text: 'Result published.', beforeReply: async () => { arrived.resolve(); await finish.promise; } },
  ]);
  cleanup.push(() => provider.close());
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], models: {
    entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }],
    apiKey: 'local-only', modelRuntime: provider.runtime,
  } };
  let runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close()); cleanup.push(async () => finish.resolve());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'high' }, 'worker');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Implement title search', requestId: 'begin' });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Title search', protocols: { data: { type: 'object' } },
    nodes: { build: { recipe: 'worker@1', model: 'local', task: 'Publish the stable plan and submit the report', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
    modules: { verify: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
    edges: { checked: { from: 'build.result', to: 'verify.job', enabled: true } },
    outputs: { result: { from: 'build.result', protocol: 'data' } }, acceptance: [{ id: 'host', description: 'Host runtime responds', kind: 'check', module: 'verify' }] });
  const main = runtime.supervisor(taskId); const task = runtime.user.task(taskId);
  const proposed = await main.propose({ requirementVersion: 1, summary: 'Title search', definition, acceptance: [{ id: 'host', description: 'Host runtime responds', checkNode: 'verify' }] }, 'proposal');
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive(); expect(provider.requests).toHaveLength(0);
  await main.graphSend({ graphId: taskId, nodeId: 'build', input: 'job', value: { objective: 'Title search' } });
  const driving = runtime.host.drive(); await arrived.promise;
  const paused = await task.pause('pause-before-check');
  const events = task.watch(paused.cursor - 1); const pauseEvent = (await events.next()).value!; await events.return();
  finish.resolve(); await driving;
  const before = runtime.nodeRun(taskId, 'build');
  expect(before.node.status).toBe('succeeded'); expect(before.instance!.used).toBe(150);
  const prepared = await main.graphInspect({ graphId: taskId, query: 'operations' }) as { id: string; state: string; started_at: number | null; worker_active: number }[];
  // submit immediately activates downstream work. A check sent before pause
  // may finish; a check not yet sent must retain its preparation and input.
  for (const operation of prepared) {
    expect(operation.worker_active).toBe(0);
    expect(['prepared', 'settled']).toContain(operation.state);
    if (operation.state === 'prepared') expect(operation.started_at).toBeNull();
    else expect(operation.started_at!).toBeLessThanOrEqual(pauseEvent.timestamp);
  }
  const published = runtime.artifacts.list(taskId).artifacts;
  expect(published).toHaveLength(1);
  const version = published[0]!;
  await expect(runtime.artifacts.read(taskId, version.artifactId, version.version)).resolves.toMatchObject({ text: 'Implemented title search' });
  await runtime.close(); runtime = await openTaskRuntime(options);
  const recovered = runtime.user.task(taskId); const recoveredMain = runtime.supervisor(taskId);
  await recovered.resume('resume'); await runtime.host.drive();
  expect(provider.requests).toHaveLength(3);
  expect(runtime.nodeRun(taskId, 'build').instance).toMatchObject({ id: before.instance!.id, used: 150 });
  await expect(recoveredMain.graphInspect({ graphId: taskId, query: 'results' })).resolves.toMatchObject([{ value: { report: 'Implemented title search' } }]);
  await expect(runtime.artifacts.read(taskId, version.artifactId, version.version)).resolves.toMatchObject({ text: 'Implemented title search' });
  await expect(recoveredMain.graphInspect({ graphId: taskId, query: 'operations' })).resolves.toMatchObject([{ ...(prepared[0] ? { id: prepared[0].id } : {}), state: 'settled', module_id: 'verify' }]);
  expect((await recovered.view()).phase).toBe('idle');
  await recoveredMain.graphControl({ graphId: taskId, action: 'complete' }); await runtime.host.drive();
  expect((await recovered.view()).phase).toBe('completed');
}, 30000);

async function nativeAgent(plans: ResponsePlan[], configuration: { access?: () => AccessPolicy; scheduler?: ReturnType<typeof createModelScheduler>; definition?: GraphDefinition; credential?: () => boolean; conversation?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-execution-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], limits: { defaultBudgetTokens: 20000000 }, ...(configuration.access ? { access: configuration.access } : {}),
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], ...(configuration.credential ? {} : { apiKey: 'local-only' }), modelRuntime: provider.runtime, ...(configuration.scheduler ? { modelScheduler: configuration.scheduler, credentialFor: () => ({ credentialId: 'credential', apiKey: 'local-only', limit: 1 }) } : {}), ...(configuration.credential ? { credentialFor: () => configuration.credential!() ? { credentialId: 'credential', apiKey: 'local-only' } : undefined } : {}) } };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'high' }, 'worker');
  const parent = configuration.conversation
    ? await runtime.conversations.create({ projectId: 'project', text: 'Work', requestId: 'begin' })
    : await runtime.user.begin({ projectId: 'project', request: 'Work', requestId: 'begin' });
  const ownerId = parent.taskId;
  const conversationId = 'conversationId' in parent && typeof parent.conversationId === 'string' ? parent.conversationId : undefined;
  const main = runtime.supervisor(ownerId);
  const { graphId } = await main.graphCreate({ definition: configuration.definition ?? parseGraphDefinition({ schemaVersion: 2, name: 'Work', protocols: {},
    nodes: { work: { recipe: 'worker@1', model: 'local', task: 'Respond to the assigned message', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {} }) }) as { graphId: string };
  return { root, runtime, provider, main, graphId, ownerId, conversationId, options, task: runtime.user.task(graphId) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('native pause before credential admission prevents sends, and an in-flight worker response drains before paused is shown', async () => {
  const arrived = deferred<void>(); const finish = deferred<void>(); const scheduler = createModelScheduler();
  const fixture = await nativeAgent([{ text: 'Completed the in-flight response', beforeReply: async () => { arrived.resolve(); await finish.promise; } }], { scheduler });
  const { runtime, main, graphId, provider, task } = fixture;
  const held = await scheduler.acquire({ credentialId: 'credential', limit: 1 });
  cleanup.push(async () => { held(); finish.resolve(); });
  await main.graphSend({ graphId, nodeId: 'work', text: 'Do the assigned work' });
  const preparing = runtime.host.drive();
  await expect.poll(() => scheduler.queued(), { timeout: 15000 }).toBe(1);
  const pause = await task.pause('pause-before-send'); expect(await task.pause('pause-before-send')).toEqual(pause);
  held(); await preparing;
  expect(provider.requests).toHaveLength(0);
  expect(await task.view()).toMatchObject({ status: 'paused' });
  expect(runtime.nodeRun(graphId, 'work').node.status).toBe('idle');
  await expect(main.graphInspect({ graphId, query: 'executions' })).resolves.toMatchObject({ items: [{ retriesUsed: 0, state: 'blocked' }] });
  await expect(main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'queued' }] });
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ used: 0, reserved: 0 });
  await task.resume('resume-task');
  const driving = runtime.host.drive(); await arrived.promise;
  await task.pause('pause-inflight'); expect(await task.view()).toMatchObject({ status: 'pausing' });
  finish.resolve(); await driving;
  expect(provider.requests).toHaveLength(1);
  expect(await task.view()).toMatchObject({ status: 'paused' });
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ used: 50, reserved: 0 });
}, 30000);

test('unknown native usage retains its hold and queued input until main reconciles and explicitly resumes', async () => {
  const { runtime, provider, main, graphId } = await nativeAgent([{ text: 'Draft response', usage: null }, { text: 'Original input recovered' }, { text: 'A follow-up response' }]);
  await main.graphSend({ graphId, nodeId: 'work', text: 'Prepare a draft' }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'work');
  expect(before.node.status).toBe('blocked'); expect(before.instance!.used).toBe(0);
  const unknown = (await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; state: string; usage: unknown; reserved: number }[])[0]!;
  expect(unknown).toMatchObject({ state: 'unknown', usage: null }); expect(unknown.reserved).toBeGreaterThan(0);
  await main.graphSend({ graphId, nodeId: 'work', text: 'Queued follow-up' }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
  const usage = { input: 30, output: 10, cacheRead: 5, cacheWrite: 5 };
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: unknown.id, usage });
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: unknown.id, usage });
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ used: 50, reserved: 0 });
  await runtime.host.drive(); expect(provider.requests).toHaveLength(1);
  await main.graphControl({ graphId, action: 'resume', nodeId: 'work' }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(3);
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ id: before.instance!.id, used: 150, reserved: 0 });
  expect(JSON.stringify(provider.requests[2])).toContain('Queued follow-up');
  expect(JSON.stringify(provider.requests[1])).toContain('Draft response');
});

test('unavailable native usage cannot be released as zero or resolved by a proof string alone', async () => {
  const { runtime, provider, main, graphId, task } = await nativeAgent([{ text: 'Usage unavailable', usage: null }]);
  await main.graphSend({ graphId, nodeId: 'work', text: 'Produce a result' }); await runtime.host.drive();
  const [unknown] = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string }[];
  await expect(main.graphControl({ graphId, action: 'reconcile_usage', callId: unknown!.id })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(main.graphControl({ graphId, action: 'reconcile_usage', callId: unknown!.id, usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } })).rejects.toMatchObject({ code: 'invalid_input' });
  await task.resume('resume-task'); await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
  await expect(main.graphInspect({ graphId, query: 'provider_calls' })).resolves.toMatchObject([{ state: 'unknown', usage: null, cost: null }]);
  const after = runtime.nodeRun(graphId, 'work'); expect(after.node.status).toBe('blocked'); expect(after.instance).toMatchObject({ used: 0, reserved: expect.any(Number) });
  expect(after.instance && 'reserved' in after.instance ? after.instance.reserved : undefined).toBeGreaterThan(0);
});

test('native submit with unresolved usage delivers once to its successor and reconciliation never replays the committed output', async () => {
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Retained submit', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'worker@1', model: 'local', task: 'Submit the answer', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
      successor: { recipe: 'worker@1', model: 'local', task: 'Read the actual incoming answer', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} } },
    modules: {}, edges: { result: { from: 'work.result', to: 'successor.job', enabled: true } }, outputs: { result: { from: 'work.result', protocol: 'data' } } });
  const { runtime, main, graphId, provider } = await nativeAgent([
    { usage: null, tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { answer: 42 } } } }) }] },
    { text: 'Received the answer.' },
  ], { definition });
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(2);
  const request = provider.requests[1] as { messages: { content: string | { type: string; text?: string }[] }[] };
  const text = request.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.map(part => part.text ?? '')).join('\n');
  expect(text).toMatch(/"answer"\s*:\s*42/);
  expect(runtime.nodeRun(graphId, 'successor').node.status).toBe('succeeded');
  const outputs = await main.graphInspect({ graphId, query: 'results' }); expect(outputs).toMatchObject([{ value: { answer: 42 } }]);
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; nodeId: string; state: string }[];
  const unknown = calls.find(call => call.state === 'unknown')!;
  const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { nodeId: string; seq: number }[] };
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: unknown.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await expect(main.graphControl({ graphId, action: 'retry', seq: queue.items.find(item => item.nodeId === 'work')!.seq })).rejects.toMatchObject({ code: 'invalid_queue' });
  await main.graphControl({ graphId, nodeId: 'work', action: 'resume' }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(2);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toEqual(outputs);
});

test('native usage reconciliation preserves the clarification sent to main and does not resume an explicitly paused input', async () => {
  const fixture = await nativeAgent([
    { tools: [{ id: 'clarify', name: 'send_to_peer', arguments: JSON.stringify({ to: 'main', text: 'Provide the missing source', requestId: 'source-question' }) }] },
    { text: 'Awaiting the source', usage: null },
    { text: 'Continue after usage reconciliation' }, { text: 'The provided source is sufficient' },
  ], { conversation: true });
  const { runtime, main, graphId, provider, conversationId } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'Work on the missing source' }); await runtime.host.drive();
  const messages = (await runtime.conversations.view(conversationId!)).messages.filter(message => message.kind === 'peer');
  expect(messages).toMatchObject([{ state: 'pending', text: expect.stringContaining('Provide the missing source') }]);
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; state: string }[];
  await main.graphControl({ graphId, action: 'pause', nodeId: 'work' });
  await main.graphSend({ graphId, nodeId: 'work', text: 'Source: verified input supplied by main' });
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: calls.find(call => call.state === 'unknown')!.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await runtime.host.drive(); expect(provider.requests).toHaveLength(2);
  expect((await runtime.conversations.view(conversationId!)).messages.filter(message => message.kind === 'peer')).toEqual(messages);
  await expect(main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'queued' }, { state: 'queued' }] });
  await main.graphControl({ graphId, action: 'resume', nodeId: 'work' }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(4);
  expect(JSON.stringify(provider.requests[3])).toContain('Source: verified input supplied by main');
  expect((await runtime.conversations.view(conversationId!)).messages.filter(message => message.kind === 'peer')).toEqual(messages);
});

test('the native cumulative budget survives restart and only an authorized next-execution budget permits more work', async () => {
  const fixture = await nativeAgent([{ text: 'Quota consumed', usage: { prompt_tokens: 19000000, completion_tokens: 1000000 } }, { text: 'Work after the authorized increase' }]);
  const { runtime, main, graphId, provider, options } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'Use the assigned quota' }); await runtime.host.drive();
  await main.graphSend({ graphId, nodeId: 'work', text: 'Continue the original assignment' }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'work');
  expect(before.node.status).toBe('blocked'); expect(before.instance).toMatchObject({ budget: 20000000, used: 20000000, reserved: 0 });
  await runtime.close(); const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  const recovered = restored.supervisor(fixture.ownerId); const task = restored.user.task(graphId);
  await task.resume('resume-task'); await restored.host.drive(); expect(provider.requests).toHaveLength(1);
  await expect(task.setBudget({ nodeId: 'absent', tokens: 40000000, requestId: 'wrong-node' })).rejects.toMatchObject({ code: 'not_found' });
  const receipt = await task.setBudget({ nodeId: 'work', tokens: 40000000, requestId: 'increase-quota' });
  expect(await task.setBudget({ nodeId: 'work', tokens: 40000000, requestId: 'increase-quota' })).toEqual(receipt);
  await recovered.graphControl({ graphId, nodeId: 'work', action: 'resume' }); await restored.host.drive();
  expect(provider.requests).toHaveLength(1); // The interrupted execution retains its frozen cap.
  const queue = await recovered.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
  const pending = queue.items.find(item => item.state === 'queued')!;
  await recovered.graphControl({ graphId, action: 'retry', seq: pending.seq }); await restored.host.drive();
  expect(provider.requests).toHaveLength(2);
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: before.instance!.id, budget: 40000000, used: 20000050, reserved: 0 });
  expect(JSON.stringify(provider.requests[1])).toContain('Quota consumed');
}, 30000);

test.each(['prepare', 'dispatch'])('native %s failure survives restart and cannot silently release input or unknown usage', async stage => {
  let available = stage !== 'prepare';
  const fixture = await nativeAgent([
    ...(stage === 'dispatch' ? [{ status: 500, error: 'Provider failed without usage', usage: null }] : []),
    { text: 'Recovered the original assignment' }, { text: 'Completed the queued follow-up' },
  ], { credential: () => available });
  const { runtime, main, graphId, ownerId, options, provider } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'Original assignment' }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'work');
  expect(before.node.status).toBe(stage === 'prepare' ? 'failed' : 'blocked');
  expect(provider.requests).toHaveLength(stage === 'prepare' ? 0 : 1);
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; state: string; usage: unknown }[];
  if (stage === 'prepare') expect(calls).toEqual([]);
  else expect(calls).toMatchObject([{ state: 'unknown', usage: null }]);
  await main.graphSend({ graphId, nodeId: 'work', text: 'Queued follow-up' }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(stage === 'prepare' ? 0 : 1);
  await runtime.close(); available = true;
  const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  const recovered = restored.supervisor(ownerId);
  await restored.host.drive(); expect(provider.requests).toHaveLength(stage === 'prepare' ? 0 : 1);
  if (stage === 'prepare') {
    const queue = await recovered.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
    await recovered.graphControl({ graphId, action: 'retry', seq: queue.items.find(item => item.state === 'failed')!.seq });
  } else {
    await recovered.graphControl({ graphId, action: 'resume', nodeId: 'work' }); await restored.host.drive();
    expect(provider.requests).toHaveLength(1);
    await recovered.graphControl({ graphId, action: 'reconcile_usage', callId: calls[0]!.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
    await restored.host.drive(); expect(provider.requests).toHaveLength(1);
    await recovered.graphControl({ graphId, action: 'resume', nodeId: 'work' });
  }
  await restored.host.drive();
  expect(provider.requests).toHaveLength(stage === 'prepare' ? 2 : 3);
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: before.instance!.id, used: stage === 'prepare' ? 100 : 150, reserved: 0 });
  expect(JSON.stringify(provider.requests.at(-1))).toContain('Queued follow-up');
  await expect(recovered.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'done' }, { state: 'done' }] });
});

test.each([
  { before: 'standard', after: 'full', changeInFlight: false },
  { before: 'full', after: 'standard', changeInFlight: true },
  { before: 'standard', after: 'full', changeInFlight: true },
] as const)('native $before to $after permission changes freeze the active turn and preserve pause across restart (in flight: $changeInFlight)', async configuration => {
  const outside = await mkdtemp(join(tmpdir(), 'graph-external-write-')); cleanup.push(() => rm(outside, { recursive: true, force: true }));
  const path = join(outside, 'result.txt');
  let policy: AccessPolicy = configuration.before === 'full' ? fullAccessPolicy() : standardAccessPolicy();
  const next = () => configuration.after === 'full' ? fullAccessPolicy() : standardAccessPolicy();
  const fixture = await nativeAgent([
    { tools: [{ id: 'first-write', name: 'write_file', arguments: JSON.stringify({ path, content: 'first' }) }],
      beforeReply: () => { if (configuration.changeInFlight) policy = next(); } },
    { text: 'First attempt finished' },
    { tools: [{ id: 'next-write', name: 'write_file', arguments: JSON.stringify({ path, content: 'second' }) }] },
    { text: 'Next attempt finished' },
  ], { access: () => policy });
  const { runtime, main, graphId, task, provider, ownerId, options } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'Write first to the requested external location' }); await runtime.host.drive();
  if (configuration.before === 'full') expect(await readFile(path, 'utf8')).toBe('first');
  else await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(provider.requests).toHaveLength(2);
  const instance = runtime.nodeRun(graphId, 'work').instance!.id;
  expect((await task.view()).questions.filter(question => question.kind === 'permission')).toEqual([]);
  await task.pause('manual-pause'); policy = next();
  await main.graphSend({ graphId, nodeId: 'work', text: 'Write second under the new policy' });
  await runtime.host.drive(); expect(provider.requests).toHaveLength(2);
  await runtime.close(); const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  const recovered = restored.supervisor(ownerId);
  await restored.host.drive(); expect(provider.requests).toHaveLength(2);
  expect(await restored.user.task(graphId).view()).toMatchObject({ status: 'paused' });
  await expect(recovered.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'done' }, { state: 'queued' }] });
  await restored.user.task(graphId).resume('resume-new-policy'); await restored.host.drive();
  expect(provider.requests).toHaveLength(4);
  expect(await readFile(path, 'utf8')).toBe(configuration.after === 'full' ? 'second' : 'first');
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: instance, used: 200, reserved: 0 });
  const deniedRequest = provider.requests[configuration.before === 'standard' ? 1 : 3];
  expect(JSON.stringify(deniedRequest)).toMatch(/outside|workspace|permission|路径/i);
});

test('native full access preserves manual pause, unknown usage and finite budget admission', async () => {
  const { runtime, main, graphId, provider, task } = await nativeAgent([{ text: 'Usage unavailable', usage: null }], { access: () => fullAccessPolicy() });
  await main.graphSend({ graphId, nodeId: 'work', text: 'Work under the declared budget' });
  await task.pause('pause-full'); await runtime.host.drive(); expect(provider.requests).toHaveLength(0);
  await task.resume('resume-full'); await runtime.host.drive(); expect(provider.requests).toHaveLength(1);
  expect(runtime.nodeRun(graphId, 'work').node.status).toBe('blocked');
  const [call] = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; state: string }[];
  expect(call!.state).toBe('unknown');
  await main.graphSend({ graphId, nodeId: 'work', text: 'Do not bypass the unresolved usage' }); await runtime.host.drive(); expect(provider.requests).toHaveLength(1);
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: call!.id, usage: { input: 19000000, output: 1000000, cacheRead: 0, cacheWrite: 0 } });
  await main.graphControl({ graphId, nodeId: 'work', action: 'resume' }); await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ used: 20000000, budget: 20000000, reserved: 0 });
});

test('native usage above a turn reservation is counted once across restart and does not exhaust a larger cumulative budget', async () => {
  const fixture = await nativeAgent([{ text: 'Large completed turn', usage: { prompt_tokens: 300000, completion_tokens: 5 } }, { text: 'Next turn' }]);
  const { runtime, main, graphId, provider, options } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'Perform the large turn' }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'work');
  expect(before.node.status).toBe('succeeded'); expect(before.instance).toMatchObject({ used: 300005, reserved: 0 });
  expect(before.invocations).toHaveLength(1);
  await runtime.close(); const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  await restored.host.drive(); expect(provider.requests).toHaveLength(1);
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: before.instance!.id, used: 300005 });
  await restored.supervisor(fixture.ownerId).graphSend({ graphId, nodeId: 'work', text: 'Continue within the remaining quota' }); await restored.host.drive();
  expect(provider.requests).toHaveLength(2);
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ used: 300055, reserved: 0 });
});

test('native business passed output cannot substitute for the declared real host acceptance check', async () => {
  const fixture = await nativeAgent([
    { tools: [{ id: 'result', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { passed: true } } } }) }] },
    { text: 'Business result submitted' },
  ], { definition: parseGraphDefinition({ schemaVersion: 2, name: 'Evidence required', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'worker@1', model: 'local', task: 'Submit the business result', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } }, edges: {},
    outputs: { result: { from: 'work.result', protocol: 'data' } }, acceptance: [{ id: 'host', description: 'The real host command must pass', kind: 'check', module: 'check' }] }) });
  const { runtime, main, graphId, provider, task } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { passed: true } }]);
  await expect(main.graphInspect({ graphId, query: 'operations' })).resolves.toEqual([]);
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await task.view()).toMatchObject({ phase: 'blocked' });
  await expect(main.graphInspect({ graphId, query: 'acceptance' })).resolves.toMatchObject({ ready: false, items: [{ id: 'host', status: 'missing' }] });
  await main.graphControl({ graphId, action: 'withdraw_complete' });
  await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
  await expect(main.graphInspect({ graphId, query: 'operations' })).resolves.toMatchObject([{ state: 'settled', result: { outputs: { result: { passed: true } } } }]);
  await expect(main.graphInspect({ graphId, query: 'acceptance' })).resolves.toMatchObject({ ready: true, items: [{ id: 'host', status: 'passed' }] });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await task.view()).toMatchObject({ phase: 'completed' });
  expect(provider.requests).toHaveLength(2);
});

test('native draft publication and an outstanding message to main survive usage reconciliation and restart without duplication', async () => {
  const fixture = await nativeAgent([
    { tools: [{ id: 'draft', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'draft', mediaType: 'text/markdown', content: 'Stable draft awaiting format', requestId: 'draft' }) }] },
    { tools: [{ id: 'format', name: 'send_to_peer', arguments: JSON.stringify({ to: 'main', text: 'Choose the final format', requestId: 'format-question' }) }] },
    { text: 'Waiting for the final format', usage: null },
  ], { conversation: true });
  const { runtime, main, graphId, provider, options, ownerId, conversationId } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'Publish the draft and ask main about its format' }); await runtime.host.drive();
  const publications = runtime.artifacts.list(graphId); expect(publications.artifacts).toHaveLength(1);
  const draft = publications.artifacts[0]!;
  const content = await runtime.artifacts.read(graphId, draft.artifactId, draft.version);
  expect(content.text).toBe('Stable draft awaiting format');
  const messages = (await runtime.conversations.view(conversationId!)).messages.filter(message => message.kind === 'peer');
  expect(messages).toMatchObject([{ state: 'pending', text: expect.stringContaining('Choose the final format') }]);
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; state: string }[];
  const instance = runtime.nodeRun(graphId, 'work').instance!.id;
  await main.graphControl({ graphId, action: 'pause', nodeId: 'work' }); await runtime.close();
  const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  const recovered = restored.supervisor(ownerId);
  await recovered.graphControl({ graphId, action: 'reconcile_usage', callId: calls.find(call => call.state === 'unknown')!.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await restored.user.task(graphId).resume('resume-task'); await restored.host.drive();
  expect(provider.requests).toHaveLength(3);
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: instance, used: 150, reserved: 0 });
  expect(restored.artifacts.list(graphId)).toEqual(publications);
  expect(await restored.artifacts.read(graphId, draft.artifactId, draft.version)).toMatchObject({ record: content.record, text: content.text });
  expect((await restored.conversations.view(conversationId!)).messages.filter(message => message.kind === 'peer')).toEqual(messages);
});

test('a conflicting late native usage reconciliation cannot overwrite the settled call or charge again', async () => {
  const { runtime, main, graphId, provider } = await nativeAgent([{ text: 'Result with delayed billing', usage: null }]);
  await main.graphSend({ graphId, nodeId: 'work', text: 'Produce a result' }); await runtime.host.drive();
  const [call] = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string }[];
  const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: call!.id, usage });
  await expect(main.graphControl({ graphId, action: 'reconcile_usage', callId: call!.id, usage: { ...usage, output: 20 } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(main.graphInspect({ graphId, query: 'provider_calls' })).resolves.toMatchObject([{ id: call!.id, state: 'reconciled', usage }]);
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ used: 50, reserved: 0 });
  await runtime.host.drive(); expect(provider.requests).toHaveLength(1);
});

test('an exactly exhausted native quota refuses zero-reservation tools and stays exhausted after restart', async () => {
  const fixture = await nativeAgent([{ usage: { prompt_tokens: 19000000, completion_tokens: 1000000 },
    tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'unauthorized.txt', content: 'must not be written' }) }] }]);
  const { runtime, main, graphId, options, provider, root } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', text: 'The zero-token tool cannot exceed the budget' }); await runtime.host.drive();
  await expect(readFile(join(root, 'unauthorized.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const before = runtime.nodeRun(graphId, 'work'); expect(before.instance).toMatchObject({ used: 20000000, reserved: 0 });
  await runtime.close(); const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  await restored.user.task(graphId).resume('resume-task'); await restored.host.drive();
  expect(provider.requests).toHaveLength(1);
  await expect(readFile(join(root, 'unauthorized.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: before.instance!.id, used: 20000000, budget: 20000000 });
});

test.each(['standard', 'full'] as const)('pause soft-stops the running master turn and a single resume continues it (%s access)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pause-master-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  // A second connection to the runtime database lets the scripted adapter use
  // the real send gate, so the first provider send is recorded as an invocation
  // exactly like a live master turn (and the pause refusal settles interrupted).
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const tool = deferred<void>();
  const partial = join(root, 'partial.txt');
  let sends = 0;
  let stopCalls = 0;
  let stopped = false;
  const entry = {
    id: 'm', modelId: 'm', provider: 'p', grade: 'high' as const, api: 'openai-completions' as const,
    baseUrl: 'https://master.example/v1', contextWindow: 32_000, maxTokens: 256, credentialId: 'c',
  };
  const adapter: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    stop: async () => { stopCalls += 1; stopped = true; tool.resolve(); },
    prepare: async operation => async () => {
      sends += 1;
      if (sends === 1) {
        // The first provider send already happened and is durable; then the
        // in-flight tool call runs and the pause refuses the next send.
        const gate = taskGate(store, { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId }, entry);
        gate.dispatch('inv-1', 0, () => 'sent');
        gate.settle('inv-1', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
        await writeFile(partial, 'completed tool effect');
        await tool.promise;
        // Standard access refuses the next send at the pause gate; full access
        // has no such gate, so the soft stop simply ends the turn normally.
        if (stopped && mode === 'standard') throw new RuntimeError('paused', 'Instance paused');
        return { outcome: 'completed', output: { text: 'first' }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
      }
      // The resumed turn runs on the same session/instance and finishes.
      return { outcome: 'completed', output: { text: 'continued' }, usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const runtime = await openTaskRuntime({
    stateDir,
    actions: { master: adapter },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    ...(mode === 'full' ? { access: () => fullAccessPolicy() } : {}),
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ text: '第一问', requestId: 'create' });
  const driving = runtime.host.runReady();
  await expect.poll(async () => (await runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('running');
  const instanceId = (await runtime.user.task(created.taskId).view()).nodes.find(node => node.id === 'master')!.instanceId;

  await runtime.conversations.pause(created.conversationId, 'pause');
  await driving;

  // The pause soft-stopped the live master turn in both access modes: the
  // in-flight tool effect is retained and the turn closed.
  expect(stopCalls).toBe(1);
  // The pause recorded a durable wake-up for the unfinished turn.
  expect(store.db.prepare('SELECT state FROM pause_continuations').all()).toEqual([{ state: 'waiting' }]);
  expect(await readFile(partial, 'utf8')).toBe('completed tool effect');
  const paused = await runtime.user.task(created.taskId).view();
  expect(paused).toMatchObject({ status: 'paused', operations: [{ workerActive: false }] });
  if (mode === 'standard') {
    // The pause gate refused the next send, so the turn closed interrupted and
    // the node is queued for the continuation.
    expect(paused.operations[0]!.state).toBe('interrupted');
    expect(paused.nodes.find(node => node.id === 'master')?.status).toBe('pending');
  } else {
    // Full access has no pause gate: the soft stop ends the turn as completed
    // and the durable wake-up puts the node back on the queue at resume.
    expect(paused.operations[0]!.state).toBe('succeeded');
    expect(paused.nodes.find(node => node.id === 'master')?.status).toBe('succeeded');
  }
  // Nothing new is dispatched while paused, in full access too.
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });

  await runtime.conversations.resume(created.conversationId, 'resume');
  // Resume turned the waiting wake-up into a dispatchable one.
  expect(store.db.prepare('SELECT state FROM pause_continuations').all()).toEqual([{ state: 'ready' }]);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  // The durable wake-up was consumed and the turn ran once on the same instance.
  const continued = await runtime.user.task(created.taskId).view();
  expect(continued.nodes.find(node => node.id === 'master')).toMatchObject({ status: 'succeeded', instanceId });
  expect(store.db.prepare('SELECT state FROM pause_continuations').all()).toEqual([{ state: 'consumed' }]);
  // The completed tool effect survived the stop and the continuation.
  expect(await readFile(partial, 'utf8')).toBe('completed tool effect');
  expect(sends).toBe(2);
  // A consumed wake-up is never replayed by another resume.
  await runtime.conversations.resume(created.conversationId, 'resume-again');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(sends).toBe(2);
}, 30_000);
