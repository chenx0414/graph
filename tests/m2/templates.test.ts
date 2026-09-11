import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import * as templates from '../../src/core/templates.ts';
import type { ActionAdapter, Json, Proposal } from '../../src/core/types.ts';
import type { ReviewReport, VerifierConfig } from '../../src/core/verification.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 };
const json = (value: unknown): Json => value as Json;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function run(create: (root: string) => { actions: Record<string, ActionAdapter>; graph: Pick<Proposal, 'nodes' | 'containers' | 'loops'>; acceptance?: Proposal['acceptance'] }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-template-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = create(root);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: fixture.actions });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Template', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Template',
    acceptance: fixture.acceptance ?? [{ id: 'works', description: 'Works', checkNode: fixture.graph.nodes.find(node => node.kind === 'program' && node.action !== 'route' && node.action !== 'join')?.id ?? 'check' }],
    ...fixture.graph,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  return { root, task, view: await task.view() };
}

const programCheck = (root: string, name = 'check'): ActionAdapter => ({ kind: 'program', prepare: async () => async () => {
  const path = join(root, `${name}.txt`); await writeFile(path, 'ok');
  return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'works', summary: 'Checked', artifact: { path, digest: digest('ok') } }] };
} });

test('pipeline, fan-out, router and supervisor-worker templates complete on the shared scheduler', async () => {
  const agent = (output: Json): ActionAdapter => ({ kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output, usage }) });
  const pipeline = await run(root => ({ actions: { implement: agent({ done: true }), check: programCheck(root, 'pipeline') }, graph: templates.pipeline() }));
  expect(pipeline.view.phase).toBe('completed');
  const fanout = await run(root => ({ actions: { left: agent({ left: true }), right: agent({ right: true }), check: programCheck(root, 'fanout') }, graph: templates.fanout() }));
  expect(fanout.view.phase).toBe('completed');
  const routed = await run(root => ({ actions: {
    route: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: { selected: 'text' }, route: 'text' }) },
    text: agent({ format: 'text' }),
    json: agent({ format: 'json' }),
    join: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: { selected: 'text' } }) },
    check: programCheck(root, 'router'),
  }, graph: templates.router() }));
  expect(routed.view.phase).toBe('completed');
  expect(routed.view.nodes.find(node => node.id === 'json')?.status).toBe('skipped');
  const supervised = await run(root => ({ actions: { master: agent({ plan: true }), worker: agent({ done: true }), check: programCheck(root, 'supervisor') }, graph: templates.supervisorWorkers(2) }));
  expect(supervised.view.phase).toBe('completed');
  expect(supervised.view.nodes.filter(node => node.role === 'worker')).toHaveLength(2);
});

test('evaluate-optimize and the three verifier templates enforce their rules on nested ordinary nodes', async () => {
  const proof = (root: string, name: string, body: string) => ({ id: name, path: join(root, `${name}.txt`), digest: digest(body) });
  let optimizeAttempts = 0;
  const optimize: VerifierConfig = { kind: 'multiview', subjectNode: 'implement', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const optimized = await run(root => ({
    actions: {
      implement: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
        optimizeAttempts++;
        const artifact = proof(root, 'opt', `v${optimizeAttempts}`);
        await writeFile(artifact.path, `v${optimizeAttempts}`);
        return { outcome: 'completed', output: { version: optimizeAttempts }, usage, artifacts: [artifact] };
      } },
      review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const artifact = operation.dependencySources.implement![0]!.artifacts[0]!;
        const report: ReviewReport = { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: {
          correctness: { verdict: (operation.dependencies.implement as { version: number }).version === 1 ? 'fail' : 'pass', reason: 'Optimize', evidence: [artifact] },
        } } };
        return { outcome: 'completed', output: json(report), usage };
      } },
    },
    graph: templates.evaluateOptimize(optimize),
    acceptance: [{ id: 'works', description: 'Optimized', checkNode: 'gate' }],
  }));
  expect(optimized.view.phase).toBe('completed');
  expect(optimizeAttempts).toBe(2);

  const criticCfg: Extract<VerifierConfig, { kind: 'adversarial' }> = { kind: 'adversarial', subjectNode: 'implement', reportNodes: ['critic'], acceptanceCriteria: ['works'] };
  const adversarial = await run(root => ({
    actions: {
      implement: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
        const artifact = proof(root, 'impl', 'ok'); await writeFile(artifact.path, 'ok');
        return { outcome: 'completed', output: null, usage, artifacts: [artifact] };
      } },
      critic: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const artifact = operation.dependencySources.implement![0]!.artifacts[0]!;
        const report: ReviewReport = { schemaVersion: 1, subject: artifact, body: { kind: 'adversarial',
          checks: { works: { verdict: 'pass', reason: 'Holds', evidence: [artifact] } },
          counterexamples: [{ id: 'old', acceptanceId: 'works', validity: 'invalid', impactsAcceptance: true, resolution: 'resolved',
            judgment: { verdict: 'pass', reason: 'Rebutted with evidence', evidence: [artifact] } }] } };
        return { outcome: 'completed', output: json(report), usage };
      } },
    },
    graph: templates.adversarial(criticCfg),
    acceptance: [{ id: 'works', description: 'Holds', checkNode: 'gate' }],
  }));
  expect(adversarial.view.phase).toBe('completed');

  const viewCfg: Extract<VerifierConfig, { kind: 'multiview' }> = { kind: 'multiview', subjectNode: 'implement', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] };
  const viewed = await run(root => ({
    actions: {
      implement: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
        const artifact = proof(root, 'impl', 'ok'); await writeFile(artifact.path, 'ok');
        return { outcome: 'completed', output: null, usage, artifacts: [artifact] };
      } },
      review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const artifact = operation.dependencySources.implement![0]!.artifacts[0]!;
        const report: ReviewReport = { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: { correctness: { verdict: 'pass', reason: 'Required dimension passed', evidence: [artifact] } } } };
        return { outcome: 'completed', output: json(report), usage };
      } },
    },
    graph: templates.multiview(viewCfg),
    acceptance: [{ id: 'works', description: 'Viewed', checkNode: 'gate' }],
  }));
  expect(viewed.view.phase).toBe('completed');

  const ranking = [{ id: 'quality', weight: 1, min: 0, max: 10 }];
  const select: Extract<VerifierConfig, { kind: 'jury' }> = { kind: 'jury', reportNodes: ['jury'], hardCriteria: ['compiles'], ranking, tieOrder: ['quality'],
    candidates: [{ id: 'a', node: 'candidate-a' }, { id: 'b', node: 'candidate-b' }] };
  const final: Extract<VerifierConfig, { kind: 'jury' }> = { ...select, reportNodes: ['final-review'], candidates: [{ id: 'absorbed', node: 'absorb' }],
    revalidate: { selectionNode: 'select', subjectNode: 'absorb' } };
  const jury = await run(root => ({
    actions: {
      candidate: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const artifact = proof(root, operation.nodeId, operation.nodeId);
        await writeFile(artifact.path, operation.nodeId);
        return { outcome: 'completed', output: { id: operation.nodeId }, usage, artifacts: [{ id: operation.nodeId, path: artifact.path, digest: artifact.digest }] };
      } },
      jury: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const a = operation.dependencySources['candidate-a']![0]!.artifacts[0]!;
        const b = operation.dependencySources['candidate-b']![0]!.artifacts[0]!;
        const entry = (artifact: typeof a, quality: number) => ({ id: artifact.nodeId === 'candidate-a' ? 'a' : 'b', artifact, hard: { compiles: { verdict: 'pass' as const, reason: 'Builds', evidence: [artifact] } }, scores: { quality: { value: quality, reason: 'Rank', evidence: [artifact] } } });
        const report: ReviewReport = { schemaVersion: 1, body: { kind: 'jury', candidates: [entry(a, 9), entry(b, 4)] } };
        return { outcome: 'completed', output: json(report), usage };
      } },
      absorb: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const artifact = proof(root, 'absorbed', 'merged');
        await writeFile(artifact.path, 'merged');
        expect(operation.dependencies.select).toMatchObject({ winner: 'a' });
        return { outcome: 'completed', output: { merged: true }, usage, artifacts: [{ id: 'absorbed', path: artifact.path, digest: artifact.digest }] };
      } },
      'final-review': { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const artifact = operation.dependencySources.absorb![0]!.artifacts[0]!;
        const report: ReviewReport = { schemaVersion: 1, body: { kind: 'jury', candidates: [{ id: 'absorbed', artifact, hard: { compiles: { verdict: 'pass', reason: 'Absorbed build', evidence: [artifact] } }, scores: { quality: { value: 9, reason: 'Still ranked', evidence: [artifact] } } }] } };
        return { outcome: 'completed', output: json(report), usage };
      } },
    },
    graph: templates.jury({ select, final }),
    acceptance: [{ id: 'works', description: 'Jury', checkNode: 'final' }],
  }));
  expect(jury.view.phase).toBe('completed');
  expect(jury.view.evidence[0]?.artifact.digest).toBe(digest('merged'));
});

