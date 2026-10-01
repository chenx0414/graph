import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import {
  ArtifactProvenance, codeRef, reviewEvidence,
} from '../../src/core/artifact-provenance.ts';

/**
 * Issue #1 §13.6 — artifact ownership and commit review references.
 *
 * Failure modes first (R24):
 *   A1  a code artifact records a stable commit, its repository and an optional
 *       worktree; a top-level artifact from inside a subgraph records the full path
 *   A2  a new version never changes an old reference: the old reference still
 *       resolves to the old digest and bytes
 *   A3  an approval that names commit X does NOT count as evidence for commit Y
 *   A4  an approval for the exact current commit DOES count
 *   A5  a review naming another commit is still recorded, marked not-current — never
 *       dropped and never silently treated as passing
 *   A6  a non-code artifact (a text report) needs no commit and is unaffected
 *   A7  the Git acceptance gate is untouched: provenance never overrides acceptance
 */

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prov-'));
  const store = new TaskStore(join(root, 'state.db'));
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${root}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('g1','p','build',1,0,'executing',0,1);
  `);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const artifacts = new ArtifactWorkspace(store, join(root, 'artifacts'));
  return { root, store, workspace, artifacts, provenance: new ArtifactProvenance(store) };
}

describe('ArtifactProvenance — code refs, subgraph paths, commit review (§13.6)', () => {
  test('A1: a code artifact records commit, repository, worktree and its subgraph path', async () => {
    const { provenance } = fixture();
    const record = provenance.publishCode({
      graphId: 'g1',
      nodePath: 'build/worker',
      subgraphPath: 'build',
      code: codeRef({ repository: '/tmp/repo', commit: 'abc1234', worktree: '/tmp/wt' }),
      version: 3,
      digest: 'sha256:deadbeef',
    });

    expect(record.nodePath).toBe('build/worker');
    expect(record.subgraphPath).toBe('build');
    expect(record.code!.commit).toBe('abc1234');
    expect(record.code!.repository).toBe('/tmp/repo');
    expect(record.code!.worktree).toBe('/tmp/wt');
    expect(record.version).toBe(3);
    expect(record.digest).toBe('sha256:deadbeef');
  });

  test('A1: a top-level artifact records no subgraph path', async () => {
    const { provenance } = fixture();
    const record = provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c1' }),
      version: 1, digest: 'd1',
    });
    expect(record.subgraphPath).toBeNull();
    expect(record.nodePath).toBe('worker');
  });

  test('A2: a new version leaves the old reference resolving to the old commit and digest', async () => {
    const { provenance } = fixture();
    const first = provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c1' }),
      version: 1, digest: 'd1',
    });
    const second = provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c2' }),
      version: 2, digest: 'd2',
    });

    expect(second.version).toBe(2);
    // The old reference is untouched: still the old commit and the old digest.
    const reread = provenance.codeRefAt('g1', 1);
    expect(reread!.code!.commit).toBe('c1');
    expect(reread!.digest).toBe('d1');
    expect(first.code!.commit).toBe('c1');
  });

  test('A3: an approval for commit X is not evidence for commit Y', async () => {
    const { provenance } = fixture();
    provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c1' }),
      version: 1, digest: 'd1',
    });
    provenance.recordReview({ graphId: 'g1', artifactVersion: 1, reviewedCommit: 'c1', passed: true, reviewer: 'r1' });
    // Version 1's own approval is real evidence for version 1.
    expect(provenance.reviewEvidenceFor('g1', 1).current!.reviewedCommit).toBe('c1');

    // A new commit arrives as version 2. The approval for c1 must not carry over,
    // even though it was recorded against the same node path.
    provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c2' }),
      version: 2, digest: 'd2',
    });

    const evidence = provenance.reviewEvidenceFor('g1', 2);
    expect(evidence.current).toBeNull();
    expect(evidence.superseded).toEqual([]);
    // And the c1 approval is still readable where it was made, not rewritten.
    expect(provenance.reviewsFor('g1', 1)![0]!.reviewedCommit).toBe('c1');
  });

  test('A4: an approval for the exact current commit counts as evidence', async () => {
    const { provenance } = fixture();
    provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c9' }),
      version: 1, digest: 'd9',
    });
    provenance.recordReview({ graphId: 'g1', artifactVersion: 1, reviewedCommit: 'c9', passed: true, reviewer: 'r1' });
    const evidence = provenance.reviewEvidenceFor('g1', 1);
    expect(evidence.current!.reviewedCommit).toBe('c9');
    expect(evidence.current!.passed).toBe(true);
  });

  test('A5: a review naming another commit is recorded, marked not-current, never dropped', async () => {
    const { provenance } = fixture();
    provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c1' }),
      version: 1, digest: 'd1',
    });
    const review = provenance.recordReview({ graphId: 'g1', artifactVersion: 1, reviewedCommit: 'other', passed: true, reviewer: 'r1' });
    // The record exists: it is kept and reported, but it is not the current evidence.
    expect(review.reviewedCommit).toBe('other');
    expect(review.isCurrentCommit).toBe(false);
    const evidence = provenance.reviewEvidenceFor('g1', 1);
    expect(evidence.current).toBeNull();
    // Kept and readable, marked superseded — not dropped, not silently passing.
    expect(evidence.superseded.map(r => r.reviewedCommit)).toEqual(['other']);
    expect(evidence.superseded[0]!.passed).toBe(true);
  });

  test('A6: a text report needs no commit and is not a code artifact', async () => {
    const { provenance } = fixture();
    const record = provenance.publishReport({
      graphId: 'g1', nodePath: 'worker', subgraphPath: null, version: 1, digest: 'd0', title: 'findings',
    });
    expect(record.code).toBeNull();
    // A review cannot claim commit evidence against a non-code artifact.
    expect(() => provenance.recordReview({ graphId: 'g1', artifactVersion: 1, reviewedCommit: 'c1', passed: true, reviewer: 'r1' }))
      .toThrow(/not a code artifact/i);
  });

  test('A7: provenance never overrides the Git acceptance gate', async () => {
    const { provenance } = fixture();
    provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c1' }),
      version: 1, digest: 'd1',
    });
    provenance.recordReview({ graphId: 'g1', artifactVersion: 1, reviewedCommit: 'c1', passed: true, reviewer: 'r1' });
    // The review is evidence, and the gate is a separate question: provenance
    // reports what was reviewed, it does not decide acceptance.
    const decision = reviewEvidence({ graphId: 'g1', artifactVersion: 1 }, provenance);
    expect(decision.evidenceCurrent).toBe(true);
    expect(decision).not.toHaveProperty('accepted');
  });

  test('A1: an empty commit or repository is refused', () => {
    const { provenance } = fixture();
    expect(() => provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '', commit: 'c1' }), version: 1, digest: 'd1',
    })).toThrow(/repository/i);
    expect(() => provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: '  ' }), version: 1, digest: 'd1',
    })).toThrow(/commit/i);
  });

  test('A2: an artifact version may never be overwritten', async () => {
    const { provenance } = fixture();
    provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'c1' }),
      version: 1, digest: 'd1',
    });
    expect(() => provenance.publishCode({
      graphId: 'g1', nodePath: 'worker', code: codeRef({ repository: '/tmp/repo', commit: 'cX' }),
      version: 1, digest: 'dX',
    })).toThrow(/immutable|already exists/i);
  });
});
