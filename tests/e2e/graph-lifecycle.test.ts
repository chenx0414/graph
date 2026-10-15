import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const data = { protocol: 'data' };
async function fixture(senderPlans: ResponsePlan[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'graph-lifecycle-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const sender = await openaiServer(senderPlans); const receiver = await openaiServer([{ text: 'The already accepted input was processed.' }]);
  cleanup.push(() => sender.close(), () => receiver.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: sender.runtime, entries: Object.entries({ sender, receiver }).map(([id, provider]) => ({
      id, provider: provider.model.provider, grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256,
    })) } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'Process the accepted input.');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Exercise graph lifecycle', requestId: 'begin' });
  return { runtime, main: runtime.supervisor(owner.taskId), sender, receiver, project };
}

// Lifecycle state comes exclusively from public accepted input/control and the ordinary host loop.
test('blocked completion remains closed until withdrawal, stopping a paused graph cancels its work and terminal graphs refuse every execution control', async () => {
  const f = await fixture();
  const definition = { schemaVersion: 2 as const, name: 'Lifecycle gates', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'worker@1', model: 'sender', task: 'Process the input', inputs: { job: data }, outputs: {}, submission: {} } },
    modules: { gate: { type: 'router' as const, trigger: 'once' as const, inputs: { job: data }, outputs: { out: data }, rules: [{ when: 'true', emit: { out: '$job' } }] } },
    edges: {}, inputs: {}, outputs: { result: { from: 'gate.out', protocol: 'data' } } };
  for (const phase of ['stopped', 'completed'] as const) {
    const { graphId } = await f.main.graphCreate({ definition }) as { graphId: string };
    await f.main.graphControl({ graphId, action: 'pause', nodeId: 'work' });
    await f.main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { marker: phase } });
    await f.main.graphControl({ graphId, action: 'complete' }); await f.runtime.host.drive();
    await expect(f.main.graphInspect({ graphId })).resolves.toMatchObject({ phase: 'blocked' });
    for (const extra of [{ nodeId: 'work', input: 'job', value: {} }, { nodeId: 'work', text: 'Fresh external work' }]) {
      await expect(f.main.graphSend({ graphId, ...extra })).rejects.toMatchObject({ code: 'completing' });
    }
    await f.main.graphControl({ graphId, action: 'withdraw_complete' });
    const queue = await f.main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string; generation: number }[] };
    expect(queue.items).toMatchObject([{ state: 'queued', generation: 0 }]); const seq = queue.items[0]!.seq;
    if (phase === 'stopped') {
      await f.main.graphControl({ graphId, action: 'pause' });
      await f.main.graphControl({ graphId, action: 'stop' }); await f.runtime.host.drive();
      await expect(f.main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ seq, state: 'done', reason: 'cancelled by stop', generation: 0 }] });
    } else {
      await f.main.graphControl({ graphId, action: 'cancel', seq });
      await f.main.graphControl({ graphId, action: 'resume', nodeId: 'work' });
      await f.main.graphSend({ graphId, nodeId: 'gate', input: 'job', value: { marker: 'LATCHED' } }); await f.runtime.host.drive();
      await expect(f.main.graphInspect({ graphId, query: 'module', id: 'gate' })).resolves.toMatchObject({ triggered: true });
      await f.main.graphControl({ graphId, action: 'complete' }); await f.runtime.host.drive();
    }
    await expect(f.main.graphInspect({ graphId })).resolves.toMatchObject({ phase, revision: 1 });
    const settledQueue = await f.main.graphInspect({ graphId, query: 'queue' });
    for (const control of [{ action: 'pause' }, { action: 'resume' }, { action: 'pause', nodeId: 'work' }, { action: 'resume', nodeId: 'work' },
      { action: 'reopen', moduleId: 'gate' }, { action: 'retry', seq }, { action: 'skip', seq }, { action: 'cancel', seq }]) {
      await expect(f.main.graphControl({ graphId, ...control })).rejects.toMatchObject({ code: 'invalid_graph', message: expect.stringContaining('Ended graph') });
    }
    await expect(f.main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Attempt reopening', patch: { name: 'reopened' } } })).rejects.toMatchObject({ code: 'invalid_graph' });
    await expect(f.main.graphControl({ graphId, action: 'withdraw_complete' })).rejects.toMatchObject({ code: 'invalid_graph' });
    expect(await f.main.graphInspect({ graphId, query: 'queue' })).toEqual(settledQueue);
    if (phase === 'completed') {
      await expect(f.main.graphInspect({ graphId, query: 'module', id: 'gate' })).resolves.toMatchObject({ triggered: true });
      await expect(f.main.graphControl({ graphId, action: 'complete' })).resolves.toMatchObject({ phase: 'completed' });
    } else await expect(f.main.graphControl({ graphId, action: 'complete' })).rejects.toMatchObject({ code: 'invalid_graph' });
    await expect(f.main.graphControl({ graphId, action: 'stop' })).resolves.toMatchObject({ phase });
  }
  expect(f.sender.requests).toEqual([]); expect(f.receiver.requests).toEqual([]);
}, 60_000);

test('a patch before native submit changes future routing while already accepted delivery and node history survive later edge removal', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const submit: ResponsePlan = { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 7 } } } }) }] };
  const f = await fixture([{ ...submit, beforeReply: async () => { entered.resolve(); await release.promise; } }, { text: 'First output has no enabled edge.' }, submit, { text: 'Second output was accepted.' }]);
  const definition = { schemaVersion: 2 as const, name: 'Patch routing', protocols: { data: { type: 'object' } },
    nodes: { a: { recipe: 'worker@1', model: 'sender', task: 'Submit number seven', inputs: { job: data }, outputs: { out: data }, submission: { required: ['out'] } },
      b: { recipe: 'worker@1', model: 'receiver', task: 'Process the already accepted number', inputs: { job: data }, outputs: {}, submission: {} } },
    modules: {}, edges: { link: { from: 'a.out', to: 'b.job', enabled: true } }, inputs: {}, outputs: {} };
  const { graphId } = await f.main.graphCreate({ definition }) as { graphId: string };
  expect(f.runtime.nodePrompt(graphId, 'a').recorded).toBeNull();
  await f.main.graphControl({ graphId, action: 'pause', nodeId: 'b' });
  await f.main.graphSend({ graphId, nodeId: 'a', input: 'job', value: {} }); const driving = f.runtime.host.drive();
  try {
    await entered.promise;
    expect(f.runtime.nodeRun(graphId, 'a').timing.inProgress).toBe(true);
    const sent = (f.sender.requests[0] as { messages: { role: string; content: unknown }[] }).messages.find(message => ['developer', 'system'].includes(message.role))!.content;
    expect(f.runtime.nodePrompt(graphId, 'a').recorded?.text).toBe(sent);
    await f.main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Disable before the actual submit arrives', patch: { edges: { link: { enabled: false } } } } });
  } finally { release.resolve(); await driving; }
  await expect(f.main.graphInspect({ graphId, query: 'edge', id: 'link' })).resolves.toMatchObject({ deliveries: [] });
  expect(f.receiver.requests).toEqual([]);
  await f.main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'Enable a new future submission', patch: { edges: { link: { enabled: true } } } } });
  await f.main.graphSend({ graphId, nodeId: 'a', input: 'job', value: {} }); await f.runtime.host.drive();
  const accepted = await f.main.graphInspect({ graphId, query: 'edge', id: 'link' });
  expect(accepted).toMatchObject({ deliveries: [{ value: { n: 7 }, receiver: { state: 'queued' } }] });
  const before = f.runtime.nodeRun(graphId, 'b').instance!.id;
  await f.main.graphPatch({ graphId, baseRevision: 3, changes: { reason: 'Remove only the future connection', patch: { edges: { link: null } } } });
  await expect(f.main.graphPatch({ graphId, baseRevision: 3, changes: { reason: 'Stale name edit', patch: { name: 'stale' } } })).rejects.toMatchObject({ code: 'stale_revision', message: expect.stringContaining('current revision is 4') });
  const revision = await f.main.graphInspect({ graphId, query: 'revision' });
  for (const changes of [{ reason: 'Ambiguous', definition, patch: {} }, { reason: 'Not an object', patch: [] },
    { reason: 'Unknown protocol', patch: { nodes: { b: { inputs: { job: { protocol: 'missing' } } } } } }]) {
    await expect(f.main.graphPatch({ graphId, baseRevision: 4, changes })).rejects.toThrow();
    expect(await f.main.graphInspect({ graphId, query: 'revision' })).toEqual(revision);
  }
  await expect(f.main.graphPatch({ graphId, baseRevision: 4, changes: { reason: 'Drop accepted work', patch: { nodes: { b: null } }, retire: ['b'] } })).rejects.toMatchObject({ code: 'pending_work' });
  expect(f.runtime.nodeRun(graphId, 'b').instance!.id).toBe(before);
  await f.main.graphControl({ graphId, action: 'resume', nodeId: 'b' }); await f.runtime.host.drive();
  expect(f.receiver.requests).toHaveLength(1); expect(JSON.stringify(f.receiver.requests[0])).toContain('"n":7'.replaceAll('"', '\\"'));
  const history = f.runtime.nodeRun(graphId, 'b');
  await f.main.graphPatch({ graphId, baseRevision: 4, changes: { reason: 'Retire explicitly after completion', patch: { nodes: { b: null } }, retire: ['b'] } });
  expect(f.runtime.nodeRun(graphId, 'b')).toMatchObject({ node: { status: 'retired' }, instance: { id: before } });
  expect(f.runtime.nodeRun(graphId, 'b').entries).toEqual(history.entries);
  await f.main.graphControl({ graphId, action: 'complete' }); await f.runtime.host.drive();
  await expect(f.main.graphInspect({ graphId })).resolves.toMatchObject({ phase: 'completed', revision: 5 });
}, 60_000);

test('literal node identities keep a submitted retry generation immutable even when its declared deliverable later fails', async () => {
  const plans: ResponsePlan[] = [];
  for (const nodeId of ['plain', 'bracket[1]', 'star*', 'question?']) {
    plans.push({ text: `First attempt did not submit for ${nodeId}` },
      { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { marker: nodeId } } } }) }] },
      { text: `Submitted output; promised file is missing for ${nodeId}` });
  }
  const f = await fixture(plans);
  for (const nodeId of ['plain', 'bracket[1]', 'star*', 'question?']) {
    const { graphId } = await f.main.graphCreate({ definition: { schemaVersion: 2, name: `Literal identity ${nodeId}`, protocols: { data: { type: 'object' } },
      nodes: { [nodeId]: { recipe: 'worker@1', model: 'sender', task: 'Submit and publish the declared file', inputs: { job: data }, outputs: { out: data }, submission: { required: ['out'] },
        workspace: { base: 'project' }, retry: { automatic: 0, resubmit: 0 }, deliverable: { path: 'missing.md', namespace: 'plans', name: 'missing' } } },
      modules: {}, edges: {}, inputs: {}, outputs: { result: { from: `${nodeId}.out`, protocol: 'data' } } } }) as { graphId: string };
    await f.main.graphSend({ graphId, nodeId, input: 'job', value: {} }); await f.runtime.host.drive();
    const queue = await f.main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string; generation: number }[] };
    expect(queue.items).toMatchObject([{ state: 'failed', generation: 0 }]); const seq = queue.items[0]!.seq;
    await f.main.graphControl({ graphId, action: 'complete' }); await f.runtime.host.drive();
    await expect(f.main.graphInspect({ graphId })).resolves.toMatchObject({ phase: 'blocked' });
    await f.main.graphControl({ graphId, action: 'retry', seq }); await f.runtime.host.drive();
    const failed = await f.main.graphInspect({ graphId, query: 'queue' });
    expect(failed, nodeId).toMatchObject({ items: [{ state: 'failed', generation: 1, reason: expect.stringContaining('never written') }] });
    await expect(f.main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { marker: nodeId } }]);
    await expect(f.main.graphControl({ graphId, action: 'retry', seq })).rejects.toMatchObject({ code: 'invalid_queue', message: expect.stringContaining('Submitted work') });
    await expect(f.main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'failed', generation: 1 }] });
    await f.main.graphControl({ graphId, action: 'skip', seq }); await f.runtime.host.drive();
    await expect(f.main.graphInspect({ graphId })).resolves.toMatchObject({ phase: 'completed' });
  }
  expect(f.sender.requests).toHaveLength(12);
}, 60_000);


test('a real Git preparation failure resumes the same creation request after repair without minting a second graph', async () => {
  const f = await fixture();
  await writeFile(join(f.project, 'README.md'), 'PREPARATION_BASELINE\n');
  for (const args of [['init', '-q', '-b', 'other'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    expect(git(f.project, args).code).toBe(0);
  }
  const definition = { schemaVersion: 2 as const, name: 'Recover creation', protocols: {}, nodes: {}, modules: {}, edges: {}, inputs: {}, outputs: {} };
  const request = { definition, targetBranch: 'main', requestId: 'create-once' };
  const first = await f.main.graphCreate(request) as { graphId: string; state: string; reason: string };
  expect(first).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/branch|main|ref/i) });
  expect((await f.runtime.user.task(first.graphId).view()).paused).toBe(true);
  expect(git(f.project, ['branch', 'main']).code).toBe(0);
  const repaired = await f.main.graphCreate(request) as { graphId: string; replayed: boolean };
  expect(repaired).toMatchObject({ graphId: first.graphId, replayed: true });
  expect((await f.runtime.user.task(first.graphId).view()).paused).toBe(false);
  const view = await f.main.graphInspect({ graphId: first.graphId });
  await expect(f.main.graphCreate(request)).resolves.toMatchObject({ graphId: first.graphId, replayed: true });
  await expect(f.main.graphCreate({ ...request, definition: { ...definition, name: 'Different content' } })).rejects.toMatchObject({
    code: 'invalid_input', message: expect.stringContaining('requestId'),
  });
  expect(await f.main.graphInspect({ graphId: first.graphId })).toEqual(view);
  await expect(f.main.graphInspect({ graphId: first.graphId, query: 'queue' })).resolves.toMatchObject({ items: [] });
  expect(f.sender.requests).toEqual([]);
  await f.main.graphControl({ graphId: first.graphId, action: 'stop' }); await f.runtime.host.drive();
});

test('a public module input validates atomically, returns its actual direct provenance and drains after external completion closes', async () => {
  const f = await fixture();
  const { graphId } = await f.main.graphCreate({ definition: { schemaVersion: 2, name: 'Public module input',
    protocols: { number: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } }, nodes: {},
    modules: { route: { type: 'router', trigger: 'each', inputs: { job: { protocol: 'number' } }, outputs: { out: { protocol: 'number' } },
      rules: [{ when: 'true', emit: { out: '$job' } }] } },
    edges: {}, inputs: { start: { to: 'route.job', protocol: 'number' } }, outputs: { result: { from: 'route.out', protocol: 'number' } } } }) as { graphId: string };
  await expect(f.main.graphSend({ graphId, input: 'start', value: { n: 'bad' } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(f.main.graphInspect({ graphId, query: 'module', id: 'route' })).resolves.toMatchObject({ inputs: [{ name: 'job', missing: true }], transitions: [] });
  expect(f.runtime.events(graphId).filter(event => event.type === 'graph.delivery.accepted')).toEqual([]);
  const accepted = await f.main.graphSend({ graphId, input: 'start', value: { n: 7 } });
  expect(accepted).toMatchObject({ delivery: { source: 'direct', edgeId: null, fromEndpoint: 'main', toEndpoint: 'route.job', protocol: 'number', value: { n: 7 }, revisionVersion: 1 } });
  await expect(f.main.graphControl({ graphId, action: 'complete' })).resolves.toMatchObject({ phase: 'completing' });
  await expect(f.main.graphSend({ graphId, nodeId: 'route', input: 'job', value: { n: 8 } })).rejects.toMatchObject({ code: 'completing' });
  await f.runtime.host.drive();
  await expect(f.main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { n: 7 } }]);
  await expect(f.main.graphInspect({ graphId })).resolves.toMatchObject({ phase: 'completed' });
  expect(f.runtime.events(graphId).filter(event => event.type === 'graph.delivery.accepted')).toHaveLength(1);
  expect(f.sender.requests).toEqual([]);
}, 60_000);
