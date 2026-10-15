import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { GraphDefinition, ModuleDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const data = { protocol: 'data' };
const node = { recipe: 'worker@1', model: 'local', task: 'Read the received input and acknowledge it', inputs: { job: data }, outputs: {}, submission: {} };
async function fixture(replies: ResponsePlan[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'graph-module-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const provider = await openaiServer(replies); cleanup.push(() => provider.close());
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    limits: { defaultBudgetTokens: 20_000_000 }, models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } } satisfies Parameters<typeof openTaskRuntime>[0];
  let runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Exercise native graph modules', requestId: 'begin' });
  let main = runtime.supervisor(owner.taskId);
  return { root, get runtime() { return runtime; }, provider, get main() { return main; }, async reopen() { await runtime.close(); runtime = await openTaskRuntime(options); main = runtime.supervisor(owner.taskId); }, async create(definition: GraphDefinition) { return (await main.graphCreate({ definition }) as { graphId: string }).graphId; },
    async send(graphId: string, nodeId: string, input: string, value: Parameters<typeof main.graphSend>[0]['value']) { await main.graphSend({ graphId, nodeId, input, ...(value === undefined ? {} : { value }) }); await runtime.host.drive(); },
    async finish(graphId: string) { await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' }); } };
}
const graph = (name: string, modules: Record<string, ModuleDefinition>): GraphDefinition => ({ schemaVersion: 2, name, protocols: { data: { type: 'object' } }, nodes: {}, modules, edges: {}, inputs: {}, outputs: {} });

test('each routing cascades through modules, preserves ordered values and leaves disabled edges empty', async () => {
  const f = await fixture([{ text: 'First review received' }, { text: 'Second review received' }]);
  const definition = graph('Each cascade', {
    gate: { type: 'router', trigger: 'each', inputs: { review: data }, outputs: { rework: data, approved: data }, rules: [
      { when: 'review.passed == false', emit: { rework: '$review' } }, { when: 'review.passed == true', emit: { approved: '$review' } },
    ] },
    second: { type: 'router', trigger: 'each', inputs: { review: data }, outputs: { out: data }, rules: [{ when: 'review.passed == false', emit: { out: '$review' } }] },
  });
  definition.nodes.worker = node;
  definition.edges = { rework: { from: 'gate.rework', to: 'worker.job', enabled: true }, approve: { from: 'gate.approved', to: 'worker.job', enabled: true }, cascade: { from: 'gate.rework', to: 'second.review', enabled: true }, off: { from: 'gate.approved', to: 'second.review', enabled: false } };
  definition.outputs.result = { from: 'second.out', protocol: 'data' };
  const id = await f.create(definition); await f.main.graphControl({ graphId: id, nodeId: 'worker', action: 'pause' });
  await f.send(id, 'gate', 'review', { passed: 'not matched' });
  await expect(f.main.graphInspect({ graphId: id, query: 'queue' })).resolves.toMatchObject({ items: [] }); expect(f.provider.requests).toHaveLength(0);
  const failed = { passed: false, reason: 'nope', reviewedCommit: 'abc' }; const passed = { passed: true, reason: 'ok', reviewedCommit: 'def' };
  await f.send(id, 'gate', 'review', failed); await f.send(id, 'gate', 'review', passed);
  await expect(f.main.graphInspect({ graphId: id, query: 'queue' })).resolves.toMatchObject({ items: [{ payload: { value: failed } }, { payload: { value: passed } }] });
  await expect(f.main.graphInspect({ graphId: id, query: 'edge', id: 'rework' })).resolves.toMatchObject({ from: 'gate.rework', deliveries: [{ source: 'module', value: failed }] });
  await expect(f.main.graphInspect({ graphId: id, query: 'edge', id: 'off' })).resolves.toMatchObject({ deliveries: [] });
  await expect(f.main.graphInspect({ graphId: id, query: 'module_values', id: 'second' })).resolves.toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ name: 'review', value: failed, delivered: true })]) });
  const gate = await f.main.graphInspect({ graphId: id, query: 'module', id: 'gate' }) as { transitions: { reason: string; ruleVersion: number }[] };
  expect(gate.transitions.map(item => item.reason)).toEqual(['no rule matched', 'review.passed == false', 'review.passed == true']);
  expect(gate.transitions.every(item => item.ruleVersion === 1)).toBe(true);
  await expect(f.main.graphInspect({ graphId: id, query: 'results' })).resolves.toMatchObject([{ value: failed }]);
  await f.main.graphControl({ graphId: id, nodeId: 'worker', action: 'resume' }); await f.runtime.host.drive();
  expect(f.provider.requests).toHaveLength(2); expect(JSON.stringify(f.provider.requests[0])).toContain('nope'); expect(JSON.stringify(f.provider.requests[1])).toContain('ok');
  await expect(f.main.graphInspect({ graphId: id, query: 'executions' })).resolves.toMatchObject({ items: [{ nodeId: 'worker', state: 'completed' }, { nodeId: 'worker', state: 'completed' }] });
  await f.finish(id);
}, 60_000);

test('once preserves updated held inputs across explicit and delivered reopen controls without replaying output', async () => {
  const f = await fixture();
  const definition = graph('Once join', { join: { type: 'router', trigger: 'once', requiredInputs: ['a', 'b'], inputs: { a: data, b: data, control: data }, outputs: { pair: data }, control: { reopen: 'control' }, rules: [{ when: '$exists(a) && $exists(b)', emit: { pair: { first: '$a', second: '$b' } } }] } });
  definition.outputs.result = { from: 'join.pair', protocol: 'data' }; const id = await f.create(definition);
  const results = () => f.main.graphInspect({ graphId: id, query: 'results' });
  await f.send(id, 'join', 'a', { passed: true }); expect(await results()).toEqual([]);
  await f.send(id, 'join', 'b', { passed: false }); expect(await results()).toMatchObject([{ value: { first: { passed: true }, second: { passed: false } } }]);
  await f.send(id, 'join', 'a', { passed: false }); expect(await results()).toHaveLength(1);
  await expect(f.main.graphInspect({ graphId: id, query: 'module_values', id: 'join' })).resolves.toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ name: 'a', delivered: true, value: { passed: false } }), expect.objectContaining({ name: 'b', delivered: true, value: { passed: false } })]) });
  await f.main.graphControl({ graphId: id, action: 'reopen', moduleId: 'join' }); await f.runtime.host.drive(); expect(await results()).toHaveLength(1);
  await f.send(id, 'join', 'b', { passed: true }); expect(await results()).toMatchObject([{}, { value: { first: { passed: false }, second: { passed: true } } }]);
  await f.send(id, 'join', 'control', { reopen: true }); expect(await results()).toHaveLength(2);
  await expect(f.main.graphInspect({ graphId: id, query: 'module_values', id: 'join' })).resolves.toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ name: 'control', delivered: false }), expect.objectContaining({ name: 'a', value: { passed: false } }), expect.objectContaining({ name: 'b', value: { passed: true } })]) });
  await f.send(id, 'join', 'a', { passed: true }); expect(await results()).toMatchObject([{}, {}, { value: { first: { passed: true }, second: { passed: true } } }]);
  await f.reopen(); await f.runtime.host.drive(); expect(await results()).toHaveLength(3); await f.finish(id);
}, 60_000);

test('rule expressions forward fields, distinguish presence and merge matching outputs in declaration order', async () => {
  const rows: { when: string; inputs: Record<string, Record<string, unknown>>; matches: boolean }[] = [
    { when: '$exists(review)', inputs: { review: { passed: true } }, matches: true },
    { when: '$missing(review)', inputs: { other: {} }, matches: true },
    { when: 'review.passed == false', inputs: { review: { passed: false } }, matches: true },
    { when: 'review.passed == false', inputs: { review: { passed: true } }, matches: false },
    { when: 'review.passed == false', inputs: { other: {} }, matches: false },
    { when: 'review.count > 3', inputs: { review: { count: 5 } }, matches: true },
    { when: 'review.count >= 5', inputs: { review: { count: 5 } }, matches: true },
    { when: 'review.name == "ok"', inputs: { review: { name: 'ok' } }, matches: true },
    { when: '$exists(a) && ($missing(b) || b.ok == true)', inputs: { a: {}, b: { ok: true } }, matches: true },
    { when: '$exists(a) && ($missing(b) || b.ok == true)', inputs: { a: {} }, matches: true },
    { when: '$exists(a) && ($missing(b) || b.ok == true)', inputs: { b: { ok: true } }, matches: false },
    { when: '!$missing(a)', inputs: { a: {} }, matches: true },
    { when: 'this.constructor', inputs: { other: {} }, matches: false },
    { when: 'this.constructor', inputs: { this: { constructor: 'anything' } }, matches: true },
    { when: 'ghost.field == 1', inputs: { other: {} }, matches: false },
  ];
  const f = await fixture();
  for (const [index, row] of rows.entries()) {
    const definition = graph(`Expression ${index}`, { rule: { type: 'router', trigger: 'each', inputs: { review: data, other: data, a: data, b: data, this: data }, outputs: { out: data }, rules: [{ when: row.when, emit: { out: { marker: 'matched' } } }] } });
    definition.outputs.result = { from: 'rule.out', protocol: 'data' }; const id = await f.create(definition);
    for (const [input, value] of Object.entries(row.inputs)) await f.send(id, 'rule', input, value as Parameters<typeof f.main.graphSend>[0]['value']);
    const result = await f.main.graphInspect({ graphId: id, query: 'results' }) as { value: unknown }[];
    expect(result.length > 0, row.when).toBe(row.matches); if (row.matches) expect(result.at(-1)!.value).toEqual({ marker: 'matched' });
    await f.finish(id);
  }
  const presence = graph('Explicit false and null are present', { rule: { type: 'router', trigger: 'each', inputs: { other: data, flag: { protocol: 'boolean' }, nullable: { protocol: 'null' } }, outputs: { absent: data, falseValue: data, nullValue: data }, rules: [
    { when: '$missing(flag)', emit: { absent: { marker: 'never delivered' } } },
    { when: '$exists(flag) && flag == false', emit: { falseValue: { marker: 'received false' } } },
    { when: '$exists(nullable) && nullable == null', emit: { nullValue: { marker: 'received null' } } },
  ] } });
  presence.protocols.boolean = { type: 'boolean' }; presence.protocols.null = { type: 'null' };
  presence.outputs = { absent: { from: 'rule.absent', protocol: 'data' }, falseValue: { from: 'rule.falseValue', protocol: 'data' }, nullValue: { from: 'rule.nullValue', protocol: 'data' } };
  const presenceId = await f.create(presence); await f.send(presenceId, 'rule', 'other', {});
  await expect(f.main.graphInspect({ graphId: presenceId, query: 'results' })).resolves.toMatchObject([{ value: { marker: 'never delivered' } }]);
  await f.send(presenceId, 'rule', 'flag', false); await f.send(presenceId, 'rule', 'nullable', null);
  const presenceResult = await f.main.graphInspect({ graphId: presenceId, query: 'results' }) as { value: unknown }[];
  expect(presenceResult.map(item => item.value)).toEqual([{ marker: 'never delivered' }, { marker: 'received false' }, { marker: 'received false' }, { marker: 'received null' }]);
  await f.finish(presenceId);
  const definition = graph('Merged outputs', { rule: { type: 'router', trigger: 'each', inputs: { a: data, b: data, review: data }, outputs: { first: data, second: data, third: data }, rules: [
    { when: '$exists(a)', emit: { first: '$a' } }, { when: '$exists(b)', emit: { second: '$b' } }, { when: 'a.count == 1', emit: { third: { reason: 'review.reason', number: 3 } } },
  ] } });
  definition.outputs = { first: { from: 'rule.first', protocol: 'data' }, second: { from: 'rule.second', protocol: 'data' }, third: { from: 'rule.third', protocol: 'data' } };
  const id = await f.create(definition); await f.send(id, 'rule', 'review', { reason: 'nope' }); await f.send(id, 'rule', 'b', { count: 2 }); await f.send(id, 'rule', 'a', { count: 1 });
  const result = await f.main.graphInspect({ graphId: id, query: 'results' }) as { value: unknown }[];
  expect(result.slice(-3).map(item => item.value)).toEqual([{ count: 1 }, { count: 2 }, { reason: 'nope', number: 3 }]);
  const detail = await f.main.graphInspect({ graphId: id, query: 'module', id: 'rule' }) as { transitions: { reason: string }[] };
  expect(detail.transitions.at(-1)!.reason).toBe('$exists(a) | $exists(b) | a.count == 1'); await f.finish(id);
}, 60_000);

test('unsafe rules and invalid emitted values pause their module, retain admitted input and refuse partial downstream work', async () => {
  const cases = [
    { when: 'review.passed == ==', fragment: 'Unexpected token' },
    { when: 'review.passed = true', fragment: 'Rules compare with ==' },
    { when: 'process.exit(1)', fragment: 'trailing' },
    { when: '(() => 1)()', fragment: 'Rules compare with ==' },
    { when: 'true', duplicate: true, fragment: 'same output' },
    { when: 'true', invalid: true, fragment: 'passed' },
    { when: '$exists(review) && $exists(other)', once: true, fragment: 'requiredInputs' },
  ];
  const f = await fixture(cases.map(() => ({ text: 'Retained input acknowledged after repair' })));
  for (const [index, row] of cases.entries()) {
    const module: ModuleDefinition = { type: 'router', trigger: row.once ? 'once' : 'each', inputs: { review: data, other: data }, outputs: { out: data, broken: data }, rules: [
      { when: row.when, emit: { out: '$review', ...(row.invalid ? { broken: { passed: 'wrong' } } : {}) } },
      ...(row.duplicate ? [{ when: 'false', emit: { out: '$review' } }] : []),
    ] };
    const definition = graph(`Defect ${index}`, { rule: module });
    definition.protocols.data = { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } };
    definition.nodes.worker = node;
    definition.edges = { out: { from: 'rule.out', to: 'worker.job', enabled: true }, broken: { from: 'rule.broken', to: 'worker.job', enabled: true } };
    const id = await f.create(definition); await f.send(id, 'rule', 'review', { passed: false });
    expect(f.runtime.events(id).filter(event => event.type === 'graph.module.failed')).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ reason: expect.stringMatching(new RegExp(row.fragment, 'i')) }) })]));
    await expect(f.main.graphInspect({ graphId: id, query: 'module_values', id: 'rule' })).resolves.toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ name: 'review', delivered: true, value: { passed: false } })]) });
    expect(f.runtime.events(id).some(event => event.type === 'graph.module.failed')).toBe(true);
    for (const edge of ['out', 'broken']) await expect(f.main.graphInspect({ graphId: id, query: 'edge', id: edge })).resolves.toMatchObject({ deliveries: [] });
    expect(f.provider.requests).toHaveLength(index);
    const failures = f.runtime.events(id).filter(event => event.type === 'graph.module.failed').length;
    // The pause is observable: a later admitted input waits without another judgment,
    // without replacing the held first value, and without waking the downstream worker.
    await f.send(id, 'rule', 'review', { passed: true });
    expect(f.runtime.events(id).filter(event => event.type === 'graph.module.failed')).toHaveLength(failures);
    await expect(f.main.graphInspect({ graphId: id, query: 'module_values', id: 'rule' })).resolves.toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ name: 'review', delivered: true, value: { passed: false } })]) });
    await expect(f.main.graphInspect({ graphId: id, query: 'executions' })).resolves.toMatchObject({ items: [] });
    expect(f.provider.requests).toHaveLength(index);
    // Stop the retained failing graph through its public control. A separate valid graph
    // proves the same host still executes ordinary native work after rejecting unsafe input.
    await f.main.graphControl({ graphId: id, action: 'stop' }); await f.runtime.host.drive();
    const valid = graph(`Valid control ${index}`, { rule: { ...module, trigger: 'each', rules: [{ when: 'true', emit: { out: '$review' } }] } });
    valid.protocols = definition.protocols; valid.nodes.worker = node; valid.edges = { out: { from: 'rule.out', to: 'worker.job', enabled: true } };
    const validId = await f.create(valid); await f.send(validId, 'rule', 'review', { passed: false });
    expect(f.provider.requests).toHaveLength(index + 1);
    await expect(f.main.graphInspect({ graphId: validId, query: 'edge', id: 'out' })).resolves.toMatchObject({ deliveries: [{ value: { passed: false } }] });
    await expect(f.main.graphInspect({ graphId: validId, query: 'executions' })).resolves.toMatchObject({ items: [{ nodeId: 'worker', state: 'completed' }] });
    await f.finish(validId);
  }
}, 60_000);
