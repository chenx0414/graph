import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import type { PublishedSubject } from '../../src/core/review-policy.ts';
import { nativeReviewPattern } from '../fixtures/native-patterns.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('pipeline, fan-out, router and supervisor-worker definitions execute through real Pi and host operations', async () => {
  for (const name of ['pipeline', 'fanout', 'router', 'supervisor-workers']) {
    const root = await mkdtemp(join(tmpdir(), 'graph-native-template-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const definition = parseGraphDefinition(JSON.parse(await readFile(join(process.cwd(), 'examples/graphs', `${name}.json`), 'utf8')));
    const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
    for (const id of ['work', 'left', 'right', 'text', 'json']) {
      const provider = await openaiServer([
        { tools: [{ id: `submit-${id}`, name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { passed: true, branch: id } } } }) }] },
        { text: `Branch ${id} submitted` },
      ]); providers[id] = provider; cleanup.push(() => provider.close());
    }
    const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], models: { apiKey: 'local-only', modelRuntime: providers.work!.runtime,
      entries: Object.entries(providers).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } });
    cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
    const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: definition.name, requestId: 'begin' }); const main = runtime.supervisor(ownerId);
    const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
    await main.graphSend({ graphId, input: 'job', value: { kind: 'text', goal: 'Execute the example' } }); await runtime.host.drive();
    const results = await main.graphInspect({ graphId, query: 'results' }) as { value: { passed: boolean; record: string } }[];
    expect(results, name).toHaveLength(1); expect(results[0]!.value.passed).toBe(true);
    const record = JSON.parse(await readFile(results[0]!.value.record, 'utf8')) as { code: number; stdout: string };
    expect(record.code).toBe(0); expect(record.stdout).toMatch(/^v24\./);
    const executions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
    expect(executions.items).toHaveLength(name === 'fanout' || name === 'supervisor-workers' ? 2 : 1);
    expect(executions.items.every(item => item.state === 'completed')).toBe(true);
    expect(Object.values(providers).flatMap(provider => provider.requests)).toHaveLength(executions.items.length * 2);
    if (name === 'router') {
      expect(executions.items[0]!.nodeId).toBe('outer/inner/text');
      await expect(main.graphInspect({ graphId, query: 'edge', id: 'outer/json' })).resolves.toMatchObject({ latest: null, deliveries: [] });
      expect(runtime.nodeRun(graphId, 'outer/inner/json').instance).toBeDefined();
    }
    if (name === 'fanout' || name === 'supervisor-workers') {
      await expect(main.graphInspect({ graphId, query: 'module', id: 'join' })).resolves.toMatchObject({ triggered: true, transitions: expect.arrayContaining([expect.objectContaining({ outputs: { result: { left: { passed: true }, right: { passed: true } } } })]) });
      expect(new Set((await runtime.user.task(graphId).view()).nodes.map(item => item.instanceId)).size).toBe(2);
      expect(executions.items.some(item => item.nodeId === 'master')).toBe(false);
    }
    expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'idle' });
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
    expect((await runtime.user.task(ownerId).view()).phase).not.toBe('completed');
  }
});

/** Exercise review patterns as ordinary native definitions, not legacy template adapters. */
async function reviewPattern(kind: 'optimize' | 'adversarial' | 'multiview' | 'jury') {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-review-pattern-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const jury = kind === 'jury';
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>; let graphId = '';
  const ref = (name: string, version?: number): PublishedSubject => {
    const artifact = runtime.artifacts.list(graphId, { namespace: 'plans', latestOnly: version === undefined }).artifacts.find(item => item.name === name && (version === undefined || item.version === version))!;
    return { artifactId: artifact.artifactId, version: artifact.version, digest: artifact.digest };
  };
  const submitted = (value: () => unknown): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit', arguments: () => JSON.stringify({ outputs: { result: { enable: true, value: value() } } }) }] });
  const published = (name: string, round: number): ResponsePlan => ({ tools: [{ id: `publish-${round}`, name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name, mediaType: 'text/markdown', content: `${name} version ${round}`, requestId: `${name}-${round}` }) }] });
  const read = (name: string, version?: number): ResponsePlan => ({ tools: [{ id: `read-${name}`, name: 'artifact_read', arguments: () => JSON.stringify(ref(name, version)) }] });
  const judged = (subject: PublishedSubject, passed = true) => ({ verdict: passed ? 'pass' : 'fail', reason: passed ? 'Current version works' : 'First version needs correction', evidence: [subject] });
  const candidate = (id: string, artifact: PublishedSubject, quality: number) => ({ id, artifact, hard: { builds: judged(artifact) }, scores: { quality: { value: quality, reason: 'Observed quality', evidence: [artifact] } } });
  const report = (round: number) => {
    if (jury) return { schemaVersion: 1, body: { kind: 'jury', candidates: [candidate('a', ref('a'), 9), candidate('b', ref('b'), 4)] } };
    const subject = ref('candidate', round);
    return { schemaVersion: 1, subject, body: kind === 'adversarial' ? { kind: 'adversarial', checks: { works: judged(subject) }, counterexamples: [{ id: 'old', acceptanceId: 'works', validity: 'invalid', impactsAcceptance: true, resolution: 'resolved', judgment: judged(subject) }] }
      : { kind: 'multiview', dimensions: { correctness: judged(subject, kind !== 'optimize' || round === 2) } } };
  };
  const rounds = kind === 'optimize' ? [1, 2] : [1];
  const plans: Record<string, ResponsePlan[]> = jury ? {
    a: [published('a', 1), submitted(() => ref('a')), { text: 'Candidate a published' }],
    b: [published('b', 1), submitted(() => ref('b')), { text: 'Candidate b published' }],
    review: [read('a'), read('b'), submitted(() => report(1)), { text: 'Candidates ranked' }],
    absorb: [read('a'), read('b'), published('absorbed', 1), submitted(() => ref('absorbed')), { text: 'Combined result published' }],
    finalreview: [read('absorbed'), submitted(() => ({ schemaVersion: 1, body: { kind: 'jury', candidates: [candidate('absorbed', ref('absorbed'), 9)] } })), { text: 'Combined result independently revalidated' }],
  } : {
    work: rounds.flatMap(round => [published('candidate', round), submitted(() => ref('candidate', round)), { text: `Candidate ${round} published` }]),
    review: rounds.flatMap(round => [read('candidate', round), submitted(() => report(round)), { text: `Candidate ${round} reviewed` }]),
  };
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const [id, responses] of Object.entries(plans)) { const provider = await openaiServer(responses); providers[id] = provider; cleanup.push(() => provider.close()); }
  runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime,
    entries: Object.entries(providers).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder'); runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const definition = await nativeReviewPattern(root, kind);
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: definition.name, requestId: 'begin' }); const main = runtime.supervisor(ownerId);
  graphId = ((await main.graphCreate({ definition })) as { graphId: string }).graphId;
  for (const nodeId of jury ? ['a', 'b'] : ['work']) await main.graphSend({ graphId, nodeId, input: 'job', value: { goal: 'Build a reviewed result' } });
  await runtime.host.drive();
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { passed: true } }]);
  expect(runtime.events(graphId, 0).filter(event => event.type === 'graph.module.failed' || event.type === 'graph.node.failed')).toEqual([]);
  const gate = await main.graphInspect({ graphId, query: 'module', id: 'gate' }) as { state: { decision: { outcome: string; winner?: string } }; transitions: { outputs: Record<string, unknown>; stateBefore: unknown; stateAfter: unknown; reason: string }[] };
  expect(gate.state.decision.outcome).toBe('pass');
  if (kind === 'optimize') {
    expect(providers.work!.requests).toHaveLength(6); expect(providers.review!.requests).toHaveLength(6);
    expect(gate.transitions.filter(item => Object.keys(item.outputs).length).map(item => Object.keys(item.outputs))).toEqual([['rework'], ['approved']]);
    const waiting = gate.transitions.find(item => JSON.stringify(item).includes('Waiting for review'))!;
    expect(waiting).toBeDefined(); expect(waiting.outputs).toEqual({}); expect(waiting.stateAfter).toEqual(waiting.stateBefore);
    expect(JSON.stringify(providers.work!.requests[3])).toContain('First version needs correction');
    expect((await runtime.artifacts.read(graphId, ref('candidate', 1).artifactId, 1)).text).toBe('candidate version 1');
    expect((await runtime.artifacts.read(graphId, ref('candidate', 2).artifactId, 2)).text).toBe('candidate version 2');
  } else if (jury) {
    expect(gate.state.decision.winner).toBe('a');
    expect(JSON.stringify(providers.absorb!.requests[0])).toContain(ref('a').digest); expect(JSON.stringify(providers.absorb!.requests[0])).toContain(ref('b').digest);
    expect(JSON.stringify(providers.absorb!.requests[0])).toContain('"winner":"a"'.replaceAll('"', '\\"'));
    expect(providers.absorb!.requests).toHaveLength(5); expect(providers.finalreview!.requests).toHaveLength(3);
    await expect(main.graphInspect({ graphId, query: 'module', id: 'final' })).resolves.toMatchObject({ state: { decision: { outcome: 'pass', winner: 'absorbed', subjects: [ref('absorbed')] } } });
    expect(JSON.stringify(providers.finalreview!.requests[1])).toContain('absorbed version 1');
  } else { expect(providers.work!.requests).toHaveLength(3); expect(providers.review!.requests).toHaveLength(3); }
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'idle' });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
}

test('evaluate-optimize and the three native review patterns enforce explicit versions and joins', async () => {
  for (const kind of ['optimize', 'adversarial', 'multiview', 'jury'] as const) await reviewPattern(kind);
}, 60_000);
