import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import type { VerifierConfig } from '../../src/core/verification.ts';

const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

export const independentReviewVerifier: VerifierConfig = { kind: 'independent', reportNodes: ['review'] };

export function independentReviewNodes(dependsOn: string): NodeSpec[] {
  return [
    { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: [dependsOn] },
    { id: 'review-gate', kind: 'program', action: 'graph.verify', dependsOn: ['review'], verifier: independentReviewVerifier },
  ];
}

export const passingReviewAction: ActionAdapter = {
  kind: 'agent',
  reserveTokens: 100,
  prepare: async operation => async () => {
    const workspace = operation.workspace!;
    let path = join(workspace, 'README.md');
    let body: string;
    try { body = await readFile(path, 'utf8'); }
    catch {
      path = join(workspace, 'package.json');
      body = await readFile(path, 'utf8');
    }
    const digest = createHash('sha256').update(body).digest('hex');
    return {
      outcome: 'completed',
      usage,
      output: { schemaVersion: 1, body: { kind: 'independent', verdict: 'pass', reason: 'Observed the current workspace', evidence: [{ path, digest }] } },
    };
  },
};

export function withIndependentReview(actions: Record<string, ActionAdapter>, nodes: NodeSpec[], dependsOn?: string) {
  if (nodes.some(node => node.id === 'review-gate')) return { actions, nodes };
  const dependency = nodes.some(node => node.id === 'review')
    ? 'review'
    : (dependsOn ?? nodes.find(node => node.kind === 'program')?.id ?? nodes.at(-1)!.id);
  return {
    actions: { review: passingReviewAction, ...actions },
    nodes: nodes.some(node => node.id === 'review')
      ? [...nodes, { id: 'review-gate', kind: 'program' as const, action: 'graph.verify', dependsOn: ['review'], verifier: independentReviewVerifier }]
      : [...nodes, ...independentReviewNodes(dependency)],
  };
}
