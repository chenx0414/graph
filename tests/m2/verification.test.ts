import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Json, NodeSpec, Proposal } from '../../src/core/types.ts';
import type { ReviewReport, VerifierConfig } from '../../src/core/verification.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
const json = (value: unknown): Json => value as Json;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const coder = { definitionVersion: 'coder@1', model: 'scripted' };
async function setup(create: (root: string) => { actions: Record<string, ActionAdapter>; nodes: NodeSpec[]; acceptance?: Proposal['acceptance']; loops?: Proposal['loops'] }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-verification-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = create(root);
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: fixture.actions };
  const runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Verify the exact implementation', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Verify the exact implementation',
    acceptance: fixture.acceptance ?? [{ id: 'works', description: 'Required review checks pass', checkNode: 'gate' }], nodes: fixture.nodes,
    ...(fixture.loops ? { loops: fixture.loops } : {}),
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task, taskId, options };
}
function implementReviewGate(root: string, config: VerifierConfig, review: (operation: import('../../src/core/types.ts').Operation) => ReviewReport, extra: Partial<ActionAdapter> = {}) {
  const artifact = { id: 'implementation', path: join(root, 'implementation.txt'), digest: digest('version one') };
  return {
    artifact,
    actions: {
      implement: { kind: 'agent' as const, reserveTokens: 100, prepare: async () => async () => {
        await writeFile(artifact.path, 'version one');
        return { outcome: 'completed' as const, output: { version: 1 }, artifacts: [artifact], usage };
      } },
      review: { kind: 'agent' as const, reserveTokens: 100, ...extra, prepare: async (operation: import('../../src/core/types.ts').Operation) => async () => ({ outcome: 'completed' as const, output: json(review(operation)), usage }) },
      'graph.verify': { kind: 'program' as const, prepare: async () => async () => ({ outcome: 'completed' as const, output: { hijacked: true } }) },
    },
    nodes: [
      { id: 'implementation', kind: 'agent' as const, action: 'implement', ...coder },
      { id: 'review', kind: 'agent' as const, action: 'review', definitionVersion: 'reviewer@1', model: 'scripted-review', dependsOn: ['implementation'] },
      { id: 'gate', kind: 'program' as const, action: 'graph.verify', dependsOn: ['implementation', 'review'], verifier: config },
    ],
  };
}

test('a built-in multiview gate delivers evidence for the exact artifact checked by its required reviewer', async () => {
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }],
  };
  const { runtime, task, root } = await setup(root => {
    const artifact = { id: 'implementation', path: join(root, 'implementation.txt'), digest: createHash('sha256').update('version one').digest('hex') };
    return {
      actions: {
        implement: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
          await writeFile(artifact.path, 'version one');
          return { outcome: 'completed', output: { version: 1 }, artifacts: [artifact], usage };
        } },
        review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const report: ReviewReport = { schemaVersion: 1, subject: operation.dependencySources.implementation![0]!.artifacts[0]!,
            body: { kind: 'multiview', dimensions: { correctness: { verdict: 'pass', reason: 'Observed the required result', evidence: [artifact] } } },
          };
          return { outcome: 'completed', output: json(report), usage };
        } },
      },
      nodes: [
        { id: 'implementation', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted' },
        { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted-review', dependsOn: ['implementation'] },
        { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['implementation', 'review'], verifier: config },
      ],
    };
  });
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.evidence).toMatchObject([{ acceptanceId: 'works', nodeId: 'gate', artifact: { path: join(root, 'implementation.txt'), digest: createHash('sha256').update('version one').digest('hex') } }]);
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ kind: 'verification', outcome: 'pass', reports: [{ nodeId: 'review' }] });
});

test('a registered graph.verify adapter cannot replace the built-in gate', async () => {
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }],
  };
  const { runtime, task } = await setup(root => {
    const fixture = implementReviewGate(root, config, operation => ({ schemaVersion: 1, subject: operation.dependencySources.implementation![0]!.artifacts[0]!,
      body: { kind: 'multiview', dimensions: { correctness: { verdict: 'pass', reason: 'Observed the required result', evidence: [operation.dependencySources.implementation![0]!.artifacts[0]!] } } } }));
    return fixture;
  });
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ kind: 'verification', outcome: 'pass' });
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).not.toMatchObject({ hijacked: true });
});

test('a required dimension failure is completed rework without acceptance evidence or an unknown result', async () => {
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }, { id: 'style', required: false, reportNode: 'review' }],
  };
  const { runtime, task } = await setup(root => implementReviewGate(root, config, operation => {
    const artifact = operation.dependencySources.implementation![0]!.artifacts[0]!;
    return { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: {
      correctness: { verdict: 'fail', reason: 'Missing the required result', evidence: [artifact] },
      style: { verdict: 'pass', reason: 'Formatting is fine', evidence: [artifact] },
    } } };
  }));
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.evidence).toEqual([]);
  expect(view.questions).toMatchObject([{ kind: 'rework', nodeId: 'gate', status: 'open' }]);
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result).toMatchObject({ outcome: 'completed', output: { kind: 'verification', outcome: 'rework' } });
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.state).toBe('succeeded');
});

test('a missing suggested dimension does not block a required pass', async () => {
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }, { id: 'style', required: false, reportNode: 'review' }],
  };
  const { runtime, task } = await setup(root => implementReviewGate(root, config, operation => {
    const artifact = operation.dependencySources.implementation![0]!.artifacts[0]!;
    return { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: {
      correctness: { verdict: 'pass', reason: 'Required behavior holds', evidence: [artifact] },
    } } };
  }));
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  expect((await task.view()).phase).toBe('completed');
});

test('a suggested dimension failure does not block a required pass', async () => {
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }, { id: 'style', required: false, reportNode: 'review' }],
  };
  const { runtime, task } = await setup(root => implementReviewGate(root, config, operation => {
    const artifact = operation.dependencySources.implementation![0]!.artifacts[0]!;
    return { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: {
      correctness: { verdict: 'pass', reason: 'Required behavior holds', evidence: [artifact] },
      style: { verdict: 'fail', reason: 'Optional style note', evidence: [artifact] },
    } } };
  }));
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  expect((await task.view()).phase).toBe('completed');
});

test('an old artifact version cannot satisfy the current gate', async () => {
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }],
  };
  const { runtime, task, root } = await setup(root => implementReviewGate(root, config, () => ({
    schemaVersion: 1,
    subject: { id: 'implementation', path: join(root, 'implementation.txt'), digest: digest('stale'), nodeId: 'implementation', operationId: 'old', activationId: 'old' },
    body: { kind: 'multiview', dimensions: { correctness: { verdict: 'pass', reason: 'Reviewed a previous file', evidence: [{ path: join(root, 'implementation.txt'), digest: digest('stale') }] } } },
  })));
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.questions).toMatchObject([{ kind: 'rework' }]);
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ outcome: 'rework' });
});

test('invalid verifier placement and duplicate dimension IDs are rejected before confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-verifier-invalid-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Check', requestId: 'begin' });
  const supervisor = runtime.supervisor(taskId);
  const config: VerifierConfig = { kind: 'multiview', subjectNode: 'implementation', reportNodes: ['review'],
    dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }],
  };
  const nodes: NodeSpec[] = [
    { id: 'implementation', kind: 'agent', action: 'implement', ...coder },
    { id: 'review', kind: 'agent', action: 'review', ...coder, dependsOn: ['implementation'] },
    { id: 'gate', kind: 'program', action: 'check', dependsOn: ['implementation', 'review'], verifier: config },
  ];
  const valid = { requirementVersion: 1, summary: 'Check', acceptance: [{ id: 'works', description: 'Works', checkNode: 'gate' }], nodes };
  await expect(supervisor.propose(valid, 'wrong-action')).rejects.toMatchObject({ code: 'invalid_proposal' });
  await expect(supervisor.propose({ ...valid, nodes: [...nodes.slice(0, 2), { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['implementation', 'review'] }] }, 'missing-config')).rejects.toMatchObject({ code: 'invalid_proposal' });
  await expect(supervisor.propose({ ...valid, nodes: [...nodes.slice(0, 2), { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['implementation', 'review'],
    verifier: { ...config, dimensions: [...config.dimensions, { id: 'correctness', required: false, reportNode: 'review' }] } }] }, 'duplicate')).rejects.toMatchObject({ code: 'invalid_proposal' });
});

test('a valid open counterexample cannot be outvoted by passing checks', async () => {
  const config: VerifierConfig = { kind: 'adversarial', subjectNode: 'implementation', reportNodes: ['review'], acceptanceCriteria: ['works'] };
  const { runtime, task } = await setup(root => implementReviewGate(root, config, operation => {
    const artifact = operation.dependencySources.implementation![0]!.artifacts[0]!;
    return { schemaVersion: 1, subject: artifact, body: { kind: 'adversarial', checks: { works: { verdict: 'pass', reason: 'Looks fine', evidence: [artifact] } },
      counterexamples: [{ id: 'broken-search', acceptanceId: 'works', validity: 'valid', impactsAcceptance: true, resolution: 'open',
        judgment: { verdict: 'fail', reason: 'Title search misses case folding', evidence: [artifact] } }] } };
  }));
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.evidence).toEqual([]);
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ outcome: 'rework', blockers: [{ id: 'broken-search' }] });
});

test('a resolved counterexample with evidence allows the adversarial gate to pass', async () => {
  const config: VerifierConfig = { kind: 'adversarial', subjectNode: 'implementation', reportNodes: ['review'], acceptanceCriteria: ['works'] };
  const { runtime, task } = await setup(root => implementReviewGate(root, config, operation => {
    const artifact = operation.dependencySources.implementation![0]!.artifacts[0]!;
    return { schemaVersion: 1, subject: artifact, body: { kind: 'adversarial', checks: { works: { verdict: 'pass', reason: 'Case folding covered', evidence: [artifact] } },
      counterexamples: [{ id: 'broken-search', acceptanceId: 'works', validity: 'invalid', impactsAcceptance: true, resolution: 'resolved',
        judgment: { verdict: 'pass', reason: 'The reported miss no longer reproduces', evidence: [artifact] } }] } };
  }));
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  expect((await task.view()).phase).toBe('completed');
});

test('a jury ranks eligible candidates by weight and a deterministic tie-break', async () => {
  const ranking = [{ id: 'quality', weight: 1, min: 0, max: 10 }, { id: 'clarity', weight: 0, min: 0, max: 10 }];
  const config: VerifierConfig = { kind: 'jury', reportNodes: ['jury'], hardCriteria: ['compiles'], ranking, tieOrder: ['clarity', 'quality'],
    candidates: [{ id: 'a', node: 'candidate-a' }, { id: 'b', node: 'candidate-b' }] };
  const { runtime, task, root } = await setup(root => {
    const artifactA = { id: 'a', path: join(root, 'a.txt'), digest: digest('alpha') };
    const artifactB = { id: 'b', path: join(root, 'b.txt'), digest: digest('beta') };
    const judged = (artifact: { id: string; path: string; digest: string; nodeId: string; operationId: string; activationId: string }, quality: number, clarity: number) => ({
      artifact, hard: { compiles: { verdict: 'pass' as const, reason: 'Builds', evidence: [artifact] } },
      scores: { quality: { value: quality, reason: 'Quality', evidence: [artifact] }, clarity: { value: clarity, reason: 'Clarity', evidence: [artifact] } },
    });
    return {
      actions: {
        candidate: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const artifact = operation.nodeId === 'candidate-a' ? artifactA : artifactB;
          await writeFile(artifact.path, operation.nodeId);
          return { outcome: 'completed', output: { id: operation.nodeId }, artifacts: [artifact], usage };
        } },
        jury: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const a = operation.dependencySources['candidate-a']![0]!.artifacts[0]!;
          const b = operation.dependencySources['candidate-b']![0]!.artifacts[0]!;
          const report: ReviewReport = { schemaVersion: 1, body: { kind: 'jury', candidates: [{ id: 'a', ...judged(a, 8, 9) }, { id: 'b', ...judged(b, 8, 4) }] } };
          return { outcome: 'completed', output: json(report), usage };
        } },
      },
      nodes: [
        { id: 'candidate-a', kind: 'agent', action: 'candidate', ...coder },
        { id: 'candidate-b', kind: 'agent', action: 'candidate', ...coder },
        { id: 'jury', kind: 'agent', action: 'jury', ...coder, dependsOn: ['candidate-a', 'candidate-b'] },
        { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['candidate-a', 'candidate-b', 'jury'], verifier: config },
      ],
    };
  });
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ winner: 'a', outcome: 'pass' });
  expect(view.evidence[0]?.artifact).toMatchObject({ path: join(root, 'a.txt'), digest: digest('alpha') });
});

test('a jury with no eligible candidate returns rework instead of picking a majority', async () => {
  const config: VerifierConfig = { kind: 'jury', reportNodes: ['jury'], hardCriteria: ['compiles'],
    ranking: [{ id: 'quality', weight: 1, min: 0, max: 10 }], tieOrder: ['quality'],
    candidates: [{ id: 'a', node: 'candidate-a' }, { id: 'b', node: 'candidate-b' }] };
  const { runtime, task } = await setup(root => {
    const artifactA = { id: 'a', path: join(root, 'a.txt'), digest: digest('alpha') };
    const artifactB = { id: 'b', path: join(root, 'b.txt'), digest: digest('beta') };
    const failed = (artifact: { id: string; path: string; digest: string; nodeId: string; operationId: string; activationId: string }) => ({
      artifact, hard: { compiles: { verdict: 'fail' as const, reason: 'Does not build', evidence: [artifact] } },
      scores: { quality: { value: 9, reason: 'Looks polished', evidence: [artifact] } },
    });
    return {
      actions: {
        candidate: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const artifact = operation.nodeId === 'candidate-a' ? artifactA : artifactB;
          await writeFile(artifact.path, operation.nodeId);
          return { outcome: 'completed', output: null, artifacts: [artifact], usage };
        } },
        jury: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const report: ReviewReport = { schemaVersion: 1, body: { kind: 'jury', candidates: [
            { id: 'a', ...failed(operation.dependencySources['candidate-a']![0]!.artifacts[0]!) },
            { id: 'b', ...failed(operation.dependencySources['candidate-b']![0]!.artifacts[0]!) },
          ] } };
          return { outcome: 'completed', output: json(report), usage };
        } },
      },
      nodes: [
        { id: 'candidate-a', kind: 'agent', action: 'candidate', ...coder },
        { id: 'candidate-b', kind: 'agent', action: 'candidate', ...coder },
        { id: 'jury', kind: 'agent', action: 'jury', ...coder, dependsOn: ['candidate-a', 'candidate-b'] },
        { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['candidate-a', 'candidate-b', 'jury'], verifier: config },
      ],
    };
  });
  for (let i = 0; i < 3; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.evidence).toEqual([]);
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).toMatchObject({ outcome: 'rework' });
  expect(view.operations.find(operation => operation.nodeId === 'gate')?.result?.output).not.toHaveProperty('winner');
});

test('revalidation cannot accept a pre-absorption candidate artifact as the current winner', async () => {
  const ranking = [{ id: 'quality', weight: 1, min: 0, max: 10 }];
  const select: Extract<VerifierConfig, { kind: 'jury' }> = { kind: 'jury', reportNodes: ['jury'], hardCriteria: ['compiles'], ranking, tieOrder: ['quality'],
    candidates: [{ id: 'a', node: 'candidate-a' }, { id: 'b', node: 'candidate-b' }] };
  const final: Extract<VerifierConfig, { kind: 'jury' }> = { ...select, reportNodes: ['final-review'], candidates: [{ id: 'absorbed', node: 'absorb' }],
    revalidate: { selectionNode: 'select', subjectNode: 'absorb' } };
  const { runtime, task, root } = await setup(root => {
    const artifactA = { id: 'a', path: join(root, 'a.txt'), digest: digest('alpha') };
    const artifactB = { id: 'b', path: join(root, 'b.txt'), digest: digest('beta') };
    return {
      actions: {
        candidate: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const artifact = operation.nodeId === 'candidate-a' ? artifactA : artifactB;
          await writeFile(artifact.path, operation.nodeId);
          return { outcome: 'completed', output: { id: operation.nodeId }, artifacts: [artifact], usage };
        } },
        jury: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const a = operation.dependencySources['candidate-a']![0]!.artifacts[0]!;
          const b = operation.dependencySources['candidate-b']![0]!.artifacts[0]!;
          const entry = (id: string, artifact: typeof a, quality: number) => ({ id, artifact, hard: { compiles: { verdict: 'pass' as const, reason: 'Builds', evidence: [artifact] } }, scores: { quality: { value: quality, reason: 'Rank', evidence: [artifact] } } });
          return { outcome: 'completed', output: json({ schemaVersion: 1, body: { kind: 'jury', candidates: [entry('a', a, 9), entry('b', b, 2)] } }), usage };
        } },
        absorb: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
          const artifact = { id: 'absorbed', path: join(root, 'merged.txt'), digest: digest('merged') };
          await writeFile(artifact.path, 'merged');
          return { outcome: 'completed', output: { merged: true }, artifacts: [artifact], usage };
        } },
        'final-review': { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
          const artifact = operation.dependencySources.absorb![0]!.artifacts[0]!;
          return { outcome: 'completed', output: json({ schemaVersion: 1, body: { kind: 'jury', candidates: [{ id: 'absorbed', artifact: { ...artifact, digest: digest('alpha'), path: join(root, 'a.txt') }, hard: { compiles: { verdict: 'pass', reason: 'Old winner', evidence: [artifact] } }, scores: { quality: { value: 9, reason: 'Old', evidence: [artifact] } } }] } }), usage };
        } },
      },
      acceptance: [{ id: 'works', description: 'Revalidated', checkNode: 'final' }],
      nodes: [
        { id: 'candidate-a', kind: 'agent', action: 'candidate', ...coder },
        { id: 'candidate-b', kind: 'agent', action: 'candidate', ...coder },
        { id: 'jury', kind: 'agent', action: 'jury', ...coder, dependsOn: ['candidate-a', 'candidate-b'] },
        { id: 'select', kind: 'program', action: 'graph.verify', dependsOn: ['candidate-a', 'candidate-b', 'jury'], verifier: select },
        { id: 'absorb', kind: 'agent', action: 'absorb', ...coder, dependsOn: ['select', 'candidate-a', 'candidate-b'] },
        { id: 'final-review', kind: 'agent', action: 'final-review', ...coder, dependsOn: ['absorb'] },
        { id: 'final', kind: 'program', action: 'graph.verify', dependsOn: ['select', 'absorb', 'final-review'], verifier: final },
      ],
    };
  });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.evidence.filter(item => item.valid)).toEqual([]);
  expect(view.operations.find(operation => operation.nodeId === 'final')?.result?.output).toMatchObject({ outcome: 'rework' });
});

