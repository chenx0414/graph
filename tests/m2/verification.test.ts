import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition, type ModuleDefinition } from '../../src/core/interface-spec.ts';
import { reviewPolicyInputs, type PublishedSubject, type ReviewDecision, type ReviewPolicy } from '../../src/core/review-policy.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const multiview = (): Extract<ReviewPolicy, { kind: 'multiview' }> => ({ kind: 'multiview', subject: 'implementation', reports: ['review'],
  dimensions: [{ id: 'correctness', required: true, report: 'review' }] });
const judged = (subject: PublishedSubject, verdict: 'pass' | 'fail' | 'unresolved' = 'pass', reason = 'Observed the required result', files?: string[]) => ({ verdict, reason, evidence: [subject], ...(files ? { files } : {}) });
const submit = (value: () => unknown): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit', arguments: () => JSON.stringify({ outputs: { result: { enable: true, value: value() } } }) }] });
const publish = (name: string, content = `stable ${name} content`, requestId = name): ResponsePlan => ({ tools: [{ id: `publish-${name}`, name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name, mediaType: 'text/markdown', content, requestId }) }] });

/** Exercise generated production policy through the normal isolated module and real Pi submissions. */
async function setup(config: ReviewPolicy, report: (refs: Record<string, PublishedSubject>) => Record<string, unknown>, options: { legacyOverride?: boolean; priorCandidate?: boolean; repeatSubject?: boolean; reviseSubject?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-review-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'review-policy.mjs'); const configuration = join(root, 'review-policy.json'); await writeFile(configuration, JSON.stringify(config));
  const generated = await promisify(execFile)(process.execPath, [join(process.cwd(), 'scripts/create-review-module.ts'), configuration, entry]);
  const module = JSON.parse(generated.stdout) as ModuleDefinition;
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>; let graphId = '';
  const subjects = config.kind === 'jury' ? config.candidates.map(item => item.subject) : [config.subject];
  const refs = (): Record<string, PublishedSubject> => {
    const current = Object.fromEntries(runtime.artifacts.list(graphId, { namespace: 'plans' }).artifacts.map(item => [item.name, { artifactId: item.artifactId, version: item.version, digest: item.digest }]));
    const old = runtime.artifacts.list(graphId, { namespace: 'plans', latestOnly: false }).artifacts.find(item => item.name === 'implementation' && item.version === 1);
    return { ...current, ...(old ? { previous: { artifactId: old.artifactId, version: old.version, digest: old.digest } } : {}) };
  };
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const port of [...subjects, ...config.reports]) {
    const plans: ResponsePlan[] = subjects.includes(port) ? [
      ...(options.priorCandidate ? [publish('original')] : []), publish(port), ...(options.reviseSubject ? [publish(port, `revised ${port} content`, `${port}-revision`)] : []), submit(() => refs()[port]!), { text: `Published ${port}` },
      ...(options.repeatSubject ? [{ tools: [{ id: 'reuse', name: 'artifact_read', arguments: () => JSON.stringify(refs()[port]!) }] }, submit(() => refs()[port]!), { text: 'Reused the stable published subject' }] : []),
    ] : [
      ...subjects.map(subject => ({ tools: [{ id: `read-${subject}`, name: 'artifact_read', arguments: () => JSON.stringify(refs()[subject]!) }] })),
      submit(() => report(refs())[port]), { text: `Reviewed ${port}` },
    ];
    const provider = await openaiServer(plans); providers[port] = provider; cleanup.push(() => provider.close());
  }
  let overrideCalls = 0;
  runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    ...(options.legacyOverride ? { actions: { 'graph.verify': { kind: 'program' as const, prepare: async () => async () => { overrideCalls++; return { outcome: 'completed' as const, output: { hijacked: true } }; } } } } : {}),
    models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime, entries: Object.entries(providers).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'high' }, 'worker'); runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: `Review ${config.kind}`, requestId: 'begin' }); const main = runtime.supervisor(ownerId);
  const data = { protocol: 'data' }; const inputs = reviewPolicyInputs(config);
  graphId = ((await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: `Native ${config.kind}`, protocols: { data: { type: 'object' } },
    nodes: Object.fromEntries(inputs.map(port => [`agent-${port}`, { recipe: `${subjects.includes(port) ? 'worker' : 'reviewer'}@1`, model: port, task: subjects.includes(port) ? 'Publish and submit the stable subject' : 'Read the exact subject and submit a structured review', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } }])),
    modules: { gate: module },
    edges: Object.fromEntries(inputs.map(port => [port, { from: `agent-${port}.result`, to: `gate.${port}`, enabled: true }])),
    outputs: { approved: { from: 'gate.approved', protocol: 'data' }, rework: { from: 'gate.rework', protocol: 'data' } } }) })) as { graphId: string }).graphId;
  for (const port of subjects) await main.graphSend({ graphId, nodeId: `agent-${port}`, input: 'job', value: {} }); await runtime.host.drive();
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toEqual([]);
  for (const port of config.reports) await main.graphSend({ graphId, nodeId: `agent-${port}`, input: 'job', value: { subjects: refs() } }); await runtime.host.drive();
  const gate = await main.graphInspect({ graphId, query: 'module', id: 'gate' }) as { state: { decision: ReviewDecision }; transitions: { outputs: Record<string, ReviewDecision> }[] };
  const decision = gate.state.decision;
  expect(runtime.events(graphId, 0).filter(item => item.type === 'graph.module.failed')).toEqual([]);
  expect(gate.transitions.filter(item => Object.keys(item.outputs).length)).toHaveLength(1);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: decision }]);
  expect((await runtime.user.task(graphId).view()).phase).toBe('idle');
  return { root, runtime, main, graphId, refs: refs(), decision, providers, gate, overrideCalls };
}
const viewReport = (subject: PublishedSubject, dimensions: Record<string, unknown>) => ({ review: { schemaVersion: 1, subject, body: { kind: 'multiview', dimensions } } });

test('a native failing judgment preserves the files to fix and explicitly configured unowned scopes', async () => {
  const config = { ...multiview(), owned: ['src/web/GraphCanvas.tsx'] };
  const { decision } = await setup(config, refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!, 'fail', 'The legend is not persistent', ['src/web/App.tsx', 'docs/legend.md']) }));
  expect(decision).toMatchObject({ outcome: 'rework', blockers: [{ id: 'correctness', files: ['src/web/App.tsx', 'docs/legend.md'] }], unowned: ['src/web/App.tsx', 'docs/legend.md'] });
});

test('a native multiview module approves the exact published artifact actually read by its required reviewer', async () => {
  const { decision, refs, providers, runtime, graphId } = await setup(multiview(), refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!) }));
  expect(decision).toMatchObject({ outcome: 'pass', subjects: [refs.implementation], reports: ['review'], blockers: [] });
  expect(providers.implementation!.requests).toHaveLength(3); expect(providers.review!.requests).toHaveLength(3);
  expect(JSON.stringify(providers.review!.requests[1])).toContain('stable implementation content');
  expect((await runtime.artifacts.read(graphId, refs.implementation!.artifactId, refs.implementation!.version)).text).toBe('stable implementation content');
});

test('a legacy graph.verify adapter cannot hijack a declared native isolated review module', async () => {
  const { decision, overrideCalls } = await setup(multiview(), refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!) }), { legacyOverride: true });
  expect(overrideCalls).toBe(0); expect(decision.outcome).toBe('pass'); expect(decision).not.toHaveProperty('hijacked');
});

test('a native required dimension failure is a completed business rework transition and does not become final acceptance evidence', async () => {
  const { decision, gate, runtime, graphId } = await setup(multiview(), refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!, 'fail', 'Missing the required result') }));
  expect(decision).toMatchObject({ outcome: 'rework', blockers: [{ id: 'correctness', reason: 'Missing the required result' }] });
  expect(gate.transitions.at(-1)!.outputs).toHaveProperty('rework');
  expect((await runtime.user.task(graphId).view()).evidence).toEqual([]);
});

test('a missing suggested native dimension does not block a required pass', async () => {
  const config = multiview(); config.dimensions.push({ id: 'style', required: false, report: 'review' });
  const { decision } = await setup(config, refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!) }));
  expect(decision.outcome).toBe('pass');
});

test('a suggested native dimension failure does not block a required pass', async () => {
  const config = multiview(); config.dimensions.push({ id: 'style', required: false, report: 'review' });
  const { decision } = await setup(config, refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!), style: judged(refs.implementation!, 'fail', 'Optional style note') }));
  expect(decision.outcome).toBe('pass'); expect(decision.blockers).toEqual([]);
});

test('a stale published version cannot satisfy the current native review policy', async () => {
  const { decision } = await setup(multiview(), refs => viewReport(refs.previous!, { correctness: judged(refs.previous!) }), { reviseSubject: true });
  expect(decision).toMatchObject({ outcome: 'rework', blockers: [{ id: 'invalid_evidence', reason: 'Review does not apply to the current published artifact version' }] });
});

test('a stable published subject can be reused by a later native execution without depending on activation identity', async () => {
  const fixture = await setup(multiview(), refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!) }), { repeatSubject: true });
  const { runtime, main, graphId, refs, providers } = fixture;
  const original = fixture.decision;
  await main.graphSend({ graphId, nodeId: 'agent-implementation', input: 'job', value: { reusePublishedSubject: refs.implementation! } }); await runtime.host.drive();
  const updated = await main.graphInspect({ graphId, query: 'module', id: 'gate' }) as { state: { decision: ReviewDecision }; transitions: { outputs: Record<string, unknown> }[] };
  expect(updated.state.decision).toEqual(original); expect(updated.transitions.filter(item => Object.keys(item.outputs).length)).toHaveLength(2);
  expect(providers.implementation!.requests).toHaveLength(6); expect(providers.review!.requests).toHaveLength(3);
  const executions = await main.graphInspect({ graphId, query: 'executions', id: 'agent-implementation' }) as { items: unknown[] }; expect(executions.items).toHaveLength(2);
});

test('native rework carries the reviewer words and touched files rather than only its verdict', async () => {
  const reason = 'The digest is reported but never verified against the published content';
  const { decision } = await setup(multiview(), refs => viewReport(refs.implementation!, { correctness: judged(refs.implementation!, 'fail', reason, ['scripts/diag-a.mjs']) }));
  expect(decision.reviewText).toMatchObject([{ report: 'review', verdict: 'fail', reason, files: ['scripts/diag-a.mjs'] }]);
});

test('native review configuration rejects duplicate dimensions and invalid module placement before creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-invalid-review-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = multiview(); config.dimensions.push({ id: 'correctness', required: false, report: 'review' });
  const configuration = join(root, 'invalid.json'); const entry = join(root, 'invalid.mjs');
  await writeFile(configuration, JSON.stringify(config));
  const failed = await promisify(execFile)(process.execPath, [join(process.cwd(), 'scripts/create-review-module.ts'), configuration, entry])
    .then(() => null, error => error as { code: number; stderr: string });
  expect(failed?.code).toBe(1); expect(failed?.stderr).toMatch(/Dimension IDs/);
  expect(await access(entry).then(() => true, () => false)).toBe(false);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }] }); cleanup.push(() => runtime.close());
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Reject invalid review configuration', requestId: 'begin' });
  const main = runtime.supervisor(owner.taskId);
  await expect(main.graphCreate({ definition: { schemaVersion: 2, name: 'Invalid placement', protocols: { data: { type: 'object' } }, nodes: {}, modules: {
    gate: { type: 'operation', trigger: 'each', inputs: {}, outputs: { result: { protocol: 'data' } }, operation: {
      action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result',
    }, code: { entry, version: 1 } },
  }, edges: {}, inputs: {}, outputs: {} } })).rejects.toThrow(/cannot also declare code/);
});

const adversarial = (): Extract<ReviewPolicy, { kind: 'adversarial' }> => ({ kind: 'adversarial', subject: 'implementation', reports: ['review'], criteria: ['works'] });
const adversarialReport = (subject: PublishedSubject, resolved: boolean) => ({ review: { schemaVersion: 1, subject, body: { kind: 'adversarial', checks: { works: judged(subject) },
  counterexamples: [{ id: 'broken-search', acceptanceId: 'works', validity: resolved ? 'invalid' : 'valid', impactsAcceptance: true, resolution: resolved ? 'resolved' : 'open', judgment: judged(subject, resolved ? 'pass' : 'fail', resolved ? 'The miss no longer reproduces' : 'Title search misses case folding') }] } } });

test('a valid open native counterexample cannot be outvoted by passing checks', async () => {
  const { decision } = await setup(adversarial(), refs => adversarialReport(refs.implementation!, false));
  expect(decision).toMatchObject({ outcome: 'rework', blockers: [{ id: 'broken-search', reason: 'Title search misses case folding' }] });
});

test('a resolved native counterexample with published evidence permits the adversarial module to pass', async () => {
  const { decision } = await setup(adversarial(), refs => adversarialReport(refs.implementation!, true)); expect(decision.outcome).toBe('pass');
});

const jury = (): Extract<ReviewPolicy, { kind: 'jury' }> => ({ kind: 'jury', reports: ['jury'], hard: ['builds'], candidates: [{ id: 'a', subject: 'candidatea' }, { id: 'b', subject: 'candidateb' }],
  ranking: [{ id: 'quality', weight: 1, min: 0, max: 10 }, { id: 'clarity', weight: 0, min: 0, max: 10 }], tieOrder: ['clarity', 'quality'] });
const candidate = (id: string, artifact: PublishedSubject, builds: boolean, quality: number, clarity: number) => ({ id, artifact, hard: { builds: judged(artifact, builds ? 'pass' : 'fail', builds ? 'Builds' : 'Does not build') },
  scores: { quality: { value: quality, reason: 'Quality', evidence: [artifact] }, clarity: { value: clarity, reason: 'Clarity', evidence: [artifact] } } });
const juryReport = (refs: Record<string, PublishedSubject>, buildsA: boolean, buildsB: boolean, qualityA = 8, qualityB = 8) => ({ jury: { schemaVersion: 1, body: { kind: 'jury', candidates: [candidate('a', refs.candidatea!, buildsA, qualityA, 9), candidate('b', refs.candidateb!, buildsB, qualityB, 4)] } } });

test('a native jury ranks eligible candidates by weight then deterministic declared tie order', async () => {
  const { decision, refs } = await setup(jury(), refs => juryReport(refs, true, true));
  expect(decision).toMatchObject({ outcome: 'pass', winner: 'a', subjects: [refs.candidatea], ranking: [{ candidateId: 'a', score: 0.8, eligible: true }, { candidateId: 'b', score: 0.8, eligible: true }] });
});

test('a native jury with no eligible candidate emits rework without a majority winner', async () => {
  const { decision } = await setup(jury(), refs => juryReport(refs, false, false));
  expect(decision).toMatchObject({ outcome: 'rework', blockers: [{ id: 'winner' }] }); expect(decision).not.toHaveProperty('winner');
});

test('a native jury retains the eligible winner even when an ineligible candidate has a higher score', async () => {
  const { decision, refs } = await setup(jury(), refs => juryReport(refs, true, false, 8, 10));
  expect(decision).toMatchObject({ outcome: 'pass', winner: 'a', subjects: [refs.candidatea], ranking: [{ eligible: true }, { eligible: false }] });
});

test('native revalidation refuses a real pre-absorption publication as the current absorbed winner', async () => {
  const config = { ...jury(), candidates: [{ id: 'absorbed', subject: 'absorbed' }] };
  const { decision, refs, runtime, graphId } = await setup(config, refs => ({ jury: { schemaVersion: 1, body: { kind: 'jury', candidates: [candidate('absorbed', refs.original!, true, 9, 9)] } } }), { priorCandidate: true });
  expect((await runtime.artifacts.read(graphId, refs.original!.artifactId, refs.original!.version)).text).toBe('stable original content');
  expect((await runtime.artifacts.read(graphId, refs.absorbed!.artifactId, refs.absorbed!.version)).text).toBe('stable absorbed content');
  expect(decision).toMatchObject({ outcome: 'rework', blockers: [{ id: 'invalid_evidence' }] }); expect(decision).not.toHaveProperty('winner');
});
