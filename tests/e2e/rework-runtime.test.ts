import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-rework-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Streaming provider that tracks real concurrency per Authorization header. */
async function trackingProvider(options: { delayMs?: number } = {}) {
  const state = { requests: [] as { authorization: string; model: string }[], inFlight: 0, maxInFlight: 0, maxByKey: new Map<string, number>(), byKey: new Map<string, number>() };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { model?: string } : {};
    const key = request.headers.authorization ?? '';
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const current = (state.byKey.get(key) ?? 0) + 1;
    state.byKey.set(key, current);
    state.maxByKey.set(key, Math.max(state.maxByKey.get(key) ?? 0, current));
    state.requests.push({ authorization: key, model: body.model ?? '' });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 200));
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
    response.end('data: [DONE]\n\n');
    state.inFlight -= 1;
    state.byKey.set(key, current - 1);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { state, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

async function gitProject(root: string) {
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("ok");\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);
  return project;
}

/** Use main's native interface path, without inferred dependencies or fabricated check evidence. */
async function startWorkers(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, projectId: string, models: Record<string, string>, onOwner?: (id: string) => void) {
  const owner = await runtime.user.begin({ projectId, request: 'Provider admission contracts', requestId: 'begin' });
  onOwner?.(owner.taskId);
  const main = runtime.supervisor(owner.taskId);
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({
    schemaVersion: 2, name: 'Provider admission', protocols: { job: { type: 'object' } },
    nodes: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
      recipe: 'coder@1', model, task: 'Reply to the explicit input.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {},
    }])), modules: {}, edges: {},
  }) }) as { graphId: string };
  for (const nodeId of Object.keys(models)) await main.graphSend({ graphId, nodeId, input: 'job', value: { request: nodeId } });
  return graphId;
}

test('credential aliases resolving to the same actual key share one limit', async () => {
  for (const aliasing of ['same-ref', 'same-value'] as const) {
    const root = await temp(`alias-${aliasing}`);
    const project = await gitProject(root);
    const provider = await trackingProvider({ delayMs: 250 });
    const credentials = aliasing === 'same-ref'
      ? { 'cred-a': { secretRef: 'KEY_A' }, 'cred-b': { secretRef: 'KEY_A' } }
      : { 'cred-a': { secretRef: 'KEY_A' }, 'cred-b': { secretRef: 'KEY_B' } };
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      models: { entries: [
        { id: 'alpha', provider: 'p-alpha', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-a' },
        { id: 'beta', provider: 'p-beta', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-b' },
      ] },
      credentials,
      limits: { credentials: { 'cred-a': 1, 'cred-b': 1 } },
    }));
    // The daemon only ever serves a console this test never opens. A stub keeps the suite
    // independent of the repository build output, which a fresh checkout does not have.
    const web = join(root, 'web');
    await mkdir(web, { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
    const daemon = await startGraphDaemon({
      configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'execute',
      env: { KEY_A: 'one-actual-key', KEY_B: 'one-actual-key' }, log: () => undefined,
    });
    cleanup.push(() => daemon.close());
    const graphId = await startWorkers(daemon.server.runtime, 'p', { workA: 'alpha', workB: 'beta' });
    await daemon.server.runtime.host.drive();
    expect(provider.state.requests).toHaveLength(3);
    expect(provider.state.requests.every(request => request.authorization === 'Bearer one-actual-key')).toBe(true);
    expect(provider.state.maxInFlight).toBe(1);
    const view = await daemon.server.runtime.user.task(graphId).view();
    expect(view.nodes.map(node => node.status)).toEqual(['succeeded', 'succeeded']);
    expect(daemon.server.runtime.nodeRun(graphId, 'workA').instance!.used).toBe(12);
    expect(daemon.server.runtime.nodeRun(graphId, 'workB').instance!.used).toBe(12);
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    const startup = await (await fetch(`${daemon.url}/api/startup`, { headers: { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '' } })).json() as { limitAliases?: Record<string, string> };
    expect(JSON.stringify(startup)).not.toContain('one-actual-key');
    expect(startup.limitAliases).toMatchObject({ 'cred-b': 'cred-a' });
    await daemon.close();
  }
}, 60_000);



test('tasks record the effective revision immediately after a hot apply', async () => {
  const root = await temp('revision');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: {}, limits: {} }, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: daemon.url, cookie, 'content-type': 'application/json' };
  const saved = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: { version: 1, projects: [{ id: 'p', root }], credentials: {}, limits: {} } }) });
  expect(await saved.json()).toMatchObject({ revision: 1, effectiveRevision: 1, applied: true, restartRequired: false });
  const first = await (await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p', request: 'before restart', requestId: 'begin-1' }) })).json() as { taskId: string };
  const firstEvents = await (await fetch(`${daemon.url}/api/tasks/${first.taskId}/events?after=0`, { headers })).json() as { type: string; data: { configRevision?: number } }[];
  // The save was applied to this daemon, so the very next task records the new revision.
  expect(firstEvents.find(event => event.type === 'task.created')?.data.configRevision).toBe(1);
  await daemon.close();
  const restarted = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => restarted.close());
  const home2 = await fetch(restarted.url, { headers: { origin: restarted.url } });
  const headers2 = { origin: restarted.url, cookie: home2.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const second = await (await fetch(`${restarted.url}/api/tasks`, { method: 'POST', headers: headers2, body: JSON.stringify({ projectId: 'p', request: 'after restart', requestId: 'begin-2' }) })).json() as { taskId: string };
  const secondEvents = await (await fetch(`${restarted.url}/api/tasks/${second.taskId}/events?after=0`, { headers: headers2 })).json() as { type: string; data: { configRevision?: number } }[];
  expect(secondEvents.find(event => event.type === 'task.created')?.data.configRevision).toBe(1);
});

test('a project removed from the config keeps its history but cannot receive new tasks', async () => {
  const root = await temp('project-removal');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'keep', root }, { id: 'drop', root }], credentials: {}, limits: {} }, null, 2));
  let daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const first = await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'drop', request: 'historical', requestId: 'begin-1' }) });
  expect(first.status).toBe(200);
  await daemon.close();
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'keep', root }], credentials: {}, limits: {} }, null, 2));
  daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  const home2 = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers2 = { origin: daemon.url, cookie: home2.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const settings = await (await fetch(`${daemon.url}/api/settings`, { headers: headers2 })).json() as { projects: { id: string }[] };
  expect(settings.projects.map(project => project.id)).toEqual(['keep']);
  const tasks = await (await fetch(`${daemon.url}/api/tasks`, { headers: headers2 })).json() as { id: string }[];
  expect(tasks).toHaveLength(1);
  const refused = await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers: headers2, body: JSON.stringify({ projectId: 'drop', request: 'no more', requestId: 'begin-2' }) });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'invalid_input' });
  const stillThere = await (await fetch(`${daemon.url}/api/tasks/${(tasks[0]!).id}`, { headers: headers2 })).json() as { projectId: string };
  expect(stillThere.projectId).toBe('drop');
});





test('conflicting alias groups are refused at save time and a hand-edited conflict still starts view-only', async () => {
  const root = await temp('alias-conflict');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  const model = (id: string, credentialId: string) => ({ id, provider: `p-${id}`, grade: 'high', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 32_000, maxTokens: 256, credentialId });
  const valid = {
    version: 1,
    projects: [{ id: 'p', root }],
    models: { entries: [model('alpha', 'cred-a'), model('beta', 'cred-b')] },
    credentials: { 'cred-a': { secretRef: 'KEY_A', sharedLimitGroupId: 'g1' }, 'cred-b': { secretRef: 'KEY_B', sharedLimitGroupId: 'g1' } },
    limits: { credentials: { 'cred-a': 1, 'cred-b': 1 }, sharedGroups: { g1: 2 } },
  };
  await writeFile(configPath, JSON.stringify(valid, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: { KEY_A: 'same-key', KEY_B: 'same-key' }, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const beforeBytes = await readFile(configPath, 'utf8');
  const conflicts = [
    { ...valid, credentials: { 'cred-a': { secretRef: 'KEY_A', sharedLimitGroupId: 'g1' }, 'cred-b': { secretRef: 'KEY_B', sharedLimitGroupId: 'g2' } }, limits: { credentials: { 'cred-a': 1, 'cred-b': 1 }, sharedGroups: { g1: 2, g2: 3 } } },
    { ...valid, credentials: { 'cred-a': { secretRef: 'KEY_A', sharedLimitGroupId: 'g1' }, 'cred-b': { secretRef: 'KEY_A', sharedLimitGroupId: 'g2' } }, limits: { credentials: { 'cred-a': 1, 'cred-b': 1 }, sharedGroups: { g1: 2, g2: 3 } } },
  ];
  for (const document of conflicts) {
    const refused = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document }) });
    expect(refused.status).toBe(400);
    const body = await refused.json() as { code: string; field?: string };
    expect(body.code).toBe('invalid_config');
    expect(body.field).toContain('sharedLimitGroupId');
    expect(await readFile(configPath, 'utf8')).toBe(beforeBytes);
    expect((await (await fetch(`${daemon.url}/api/config`, { headers })).json() as { revision: number }).revision).toBe(0);
  }
  // A fixed document saves and restarts cleanly.
  const fixed = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: valid }) });
  expect(fixed.status).toBe(200);
  await daemon.close();

  // A hand-edited conflict must not stop the console; execute mode still refuses it.
  const handEdited = JSON.stringify(conflicts[0], null, 2);
  await writeFile(configPath, handEdited);
  const viewOnly = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: { KEY_A: 'same-key', KEY_B: 'same-key' }, log: () => undefined });
  cleanup.push(() => viewOnly.close().catch(() => undefined));
  const home2 = await fetch(viewOnly.url, { headers: { origin: viewOnly.url } });
  const startup = await (await fetch(`${viewOnly.url}/api/startup`, { headers: { origin: viewOnly.url, cookie: home2.headers.get('set-cookie') ?? '' } })).json() as { configured: boolean; enabledModelCount: number };
  expect(startup.configured).toBe(false);
  expect(startup.enabledModelCount).toBe(0);
  await viewOnly.close();
  await expect(startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'execute', env: { KEY_A: 'same-key', KEY_B: 'same-key' }, log: () => undefined }))
    .rejects.toMatchObject({ code: 'invalid_config' });
  expect(await readFile(configPath, 'utf8')).toBe(handEdited);
}, 60_000);



const write = (path: string, content: string, unknown = false): ResponsePlan => ({
  ...(unknown ? { usage: null } : {}), tools: [{ id: path, name: 'write_file', arguments: JSON.stringify({ path, content }) }],
});

async function partialWork(plans: ResponsePlan[]) {
  const root = await temp('native-partial'); const project = join(root, 'project'); await mkdir(project);
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const modelScheduler = createModelScheduler(); let graphId = '';
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>;
  runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    limits: { defaultBudgetTokens: 20000000 }, catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }],
      apiKey: 'local-only', modelRuntime: provider.runtime, modelScheduler, credentialFor: () => ({ credentialId: 'cred', apiKey: 'local-only', limit: 2 }) },
  }); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  let ownerId = '';
  graphId = await startWorkers(runtime, 'p', { work: 'local' }, id => { ownerId = id; });
  const main = runtime.supervisor(ownerId);
  return { runtime, provider, project, graphId, main, task: runtime.user.task(graphId),
    run: () => runtime.nodeRun(graphId, 'work'), calls: () => main.graphInspect({ graphId, query: 'provider_calls' }),
    queue: () => main.graphInspect({ graphId, query: 'queue' }),
  };
}



test('unknown usage after a partial write keeps its hold through resume until main records the exact call usage', async () => {
  const f = await partialWork([write('partial.txt', 'partial output'), write('unmetered.txt', 'must wait', true), { text: 'Work complete after reconciliation' }]);
  await f.runtime.host.drive(); const before = f.run();
  expect(f.provider.requests).toHaveLength(2); expect(before.node.status).toBe('blocked');
  expect(before.instance!.used).toBe(50); expect(before.operations[0]!.reserved).toBeGreaterThan(0);
  expect(await readFile(join(f.project, 'partial.txt'), 'utf8')).toBe('partial output');
  const calls = await f.calls() as { id: string; state: string; usage: unknown }[];
  expect(calls).toMatchObject([{ state: 'settled' }, { state: 'unknown', usage: null }]);
  await expect(readFile(join(f.project, 'unmetered.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.main.graphControl({ graphId: f.graphId, action: 'reconcile_usage', callId: calls[1]!.id })).rejects.toMatchObject({ code: 'invalid_input' });
  await f.task.resume('resume-without-usage'); await f.runtime.host.drive();
  expect(f.provider.requests).toHaveLength(2); expect(f.run().operations[0]!.reserved).toBeGreaterThan(0);
  const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
  await f.main.graphControl({ graphId: f.graphId, action: 'reconcile_usage', callId: calls[1]!.id, usage });
  await f.main.graphControl({ graphId: f.graphId, action: 'reconcile_usage', callId: calls[1]!.id, usage });
  expect(f.run().instance!.used).toBe(100);
  await f.main.graphControl({ graphId: f.graphId, nodeId: 'work', action: 'resume' }); await f.runtime.host.drive();
  const after = f.run(); expect(after.node.status).toBe('succeeded'); expect(after.instance!.used).toBe(150);
  expect(after.session!.sessionId).toBe(before.session!.sessionId);
  expect(after.operations[0]!.id).toBe(before.operations[0]!.id);
  expect(f.provider.requests).toHaveLength(3);
  expect(await readFile(join(f.project, 'partial.txt'), 'utf8')).toBe('partial output');
}, 60000);

test('mixed known and unknown usage preserves both real writes and counts each provider call once on continuation', async () => {
  const f = await partialWork([write('partial.txt', 'first output'), write('second.txt', 'second output'), { text: 'Stopped before final confirmation', usage: null }, { text: 'Complete after reconciliation' }]);
  await f.runtime.host.drive(); const before = f.run();
  expect(f.provider.requests).toHaveLength(3); expect(before.instance!.used).toBe(100);
  expect(before.operations[0]!.reserved).toBeGreaterThan(0);
  expect(await readFile(join(f.project, 'partial.txt'), 'utf8')).toBe('first output');
  expect(await readFile(join(f.project, 'second.txt'), 'utf8')).toBe('second output');
  const calls = await f.calls() as { id: string; state: string }[];
  expect(calls.map(call => call.state)).toEqual(['settled', 'settled', 'unknown']);
  await f.main.graphControl({ graphId: f.graphId, action: 'reconcile_usage', callId: calls[2]!.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  expect(f.run().instance!.used).toBe(150);
  await f.main.graphControl({ graphId: f.graphId, nodeId: 'work', action: 'resume' }); await f.runtime.host.drive();
  const after = f.run(); expect(after.node.status).toBe('succeeded'); expect(after.instance!.used).toBe(200);
  expect(after.session!.sessionId).toBe(before.session!.sessionId);
  expect(after.operations[0]!.id).toBe(before.operations[0]!.id);
  expect(f.provider.requests).toHaveLength(4);
  expect(await readFile(join(f.project, 'partial.txt'), 'utf8')).toBe('first output');
  expect(await readFile(join(f.project, 'second.txt'), 'utf8')).toBe('second output');
}, 60000);

const result = (value: unknown): ResponsePlan => ({ tools: [{ id: 'result', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value } } }) }] });
const lastUser = (request: unknown) => JSON.stringify((request as { messages: { role: string; content: unknown }[] }).messages.filter(message => message.role === 'user').at(-1)?.content);

async function reworkGraph(unknown = false) {
  const root = await temp('native-rework'); const project = join(root, 'project'); await mkdir(project);
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const first = { implementation: 'FIRST_IMPLEMENTATION' }; const second = { implementation: 'SECOND_IMPLEMENTATION' };
  const failed = { passed: false, reason: 'typecheck-failed: two type errors in src/a.ts' };
  const passed = { passed: true, reason: 'Second implementation reviewed' };
  const worker = await openaiServer([result(first), { text: 'PRIVATE_FIRST_WORKER_REPLY' },
    ...(unknown ? [write('fix.txt', 'real second round fix'), { text: 'Waiting for usage reconciliation', usage: null } as ResponsePlan] : []),
    result(second), { text: 'Second implementation submitted' }]); cleanup.push(() => worker.close());
  const reviewer = await openaiServer([result(failed), { text: 'PRIVATE_FIRST_REVIEW_REPLY' }, result(passed), { text: 'Second review complete' }]); cleanup.push(() => reviewer.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    limits: { defaultBudgetTokens: 20000000 }, catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: worker.runtime, entries: [['worker', worker], ['reviewer', reviewer]].map(([id, provider]) => {
      const server = provider as typeof worker; return { id: id as string, modelId: id as string, provider: server.model.provider, grade: 'high', api: 'openai-completions', baseUrl: server.model.baseUrl, contextWindow: 32000, maxTokens: 256 };
    }) } }); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Repair type errors', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  const data = { protocol: 'data' };
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Explicit rework', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'worker', task: 'Repair the type errors in src/a.ts using the explicit feedback.', acceptance: ['Types compile'], inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } },
      review: { recipe: 'reviewer@1', model: 'reviewer', task: 'Review the current implementation', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } } },
    modules: { route: { type: 'router', trigger: 'each', inputs: { review: data }, outputs: { rework: data, approved: data }, rules: [
      { when: 'review.passed == false', emit: { rework: '$review' } }, { when: 'review.passed == true', emit: { approved: '$review' } },
    ] } }, edges: { workReview: { from: 'work.result', to: 'review.job', enabled: true }, reviewRoute: { from: 'review.result', to: 'route.review', enabled: true },
      feedback: { from: 'route.rework', to: 'work.job', enabled: true } }, outputs: { approved: { from: 'route.approved', protocol: 'data' } },
  }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { request: 'INITIAL_WORK_REQUEST' } });
  return { runtime, main, graphId, worker, reviewer, project, first, second, failed, passed,
    run: () => runtime.nodeRun(graphId, 'work'), results: () => main.graphInspect({ graphId, query: 'results' }) };
}

test('the second round of explicit rework reads the failure delta and preserves its actual original conversation', async () => {
  const f = await reworkGraph(); await f.runtime.host.drive();
  expect(f.worker.requests).toHaveLength(4); expect(f.reviewer.requests).toHaveLength(4);
  const initial = lastUser(f.worker.requests[0]); const feedback = lastUser(f.worker.requests[2]);
  expect(initial).toContain('INITIAL_WORK_REQUEST'); expect(initial).toContain('Repair the type errors in src/a.ts');
  expect(feedback).toContain('typecheck-failed'); expect(feedback).toContain('two type errors in src/a.ts');
  expect(feedback).not.toContain('INITIAL_WORK_REQUEST'); expect(feedback).not.toContain('Repair the type errors in src/a.ts');
  expect(JSON.stringify(f.worker.requests[2])).toContain('PRIVATE_FIRST_WORKER_REPLY');
  expect(JSON.stringify(f.worker.requests[2])).not.toContain('PRIVATE_FIRST_REVIEW_REPLY');
  const run = f.run(); expect(run.operations).toHaveLength(2);
  expect(run.operations.map(item => item.state)).toEqual(['completed', 'completed']); expect(run.instance!.used).toBe(200);
  const edge = await f.main.graphInspect({ graphId: f.graphId, query: 'edge', id: 'workReview' });
  expect(edge).toMatchObject({ deliveries: [{ value: f.second }, { value: f.first }] });
  await expect(f.results()).resolves.toMatchObject([{ value: f.passed }]);
}, 60000);

test('unknown usage in a rework round cannot reuse the first submission and resumes the same pending execution after reconciliation', async () => {
  const f = await reworkGraph(true); await f.runtime.host.drive(); const before = f.run();
  expect(f.worker.requests).toHaveLength(4); expect(f.reviewer.requests).toHaveLength(2);
  expect(before.node.status).toBe('blocked'); expect(before.operations).toHaveLength(2);
  expect(before.operations.map(item => item.state)).toEqual(['completed', 'blocked']);
  expect(before.instance!.used).toBe(150); expect(before.operations[1]!.reserved).toBeGreaterThan(0);
  expect(await readFile(join(f.project, 'fix.txt'), 'utf8')).toBe('real second round fix');
  await expect(f.results()).resolves.toEqual([]);
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'edge', id: 'workReview' })).resolves.toMatchObject({ deliveries: [{ value: f.first }] });
  const calls = await f.main.graphInspect({ graphId: f.graphId, query: 'provider_calls', id: 'work' }) as { id: string; state: string }[];
  await f.main.graphControl({ graphId: f.graphId, action: 'reconcile_usage', callId: calls.find(call => call.state === 'unknown')!.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await f.main.graphControl({ graphId: f.graphId, nodeId: 'work', action: 'resume' }); await f.runtime.host.drive();
  const after = f.run(); expect(after.node.status).toBe('succeeded'); expect(after.instance).toMatchObject({ id: before.instance!.id, used: 300 });
  expect(after.session!.sessionId).toBe(before.session!.sessionId);
  expect(after.operations).toMatchObject([{ id: before.operations[0]!.id, state: 'completed' }, { id: before.operations[1]!.id, state: 'completed' }]);
  expect(f.worker.requests).toHaveLength(6); expect(f.reviewer.requests).toHaveLength(4);
  await expect(f.main.graphInspect({ graphId: f.graphId, query: 'edge', id: 'workReview' })).resolves.toMatchObject({ deliveries: [{ value: f.second }, { value: f.first }] });
  await expect(f.results()).resolves.toMatchObject([{ value: f.passed }]);
}, 60000);
