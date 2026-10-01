import { RuntimeError, type Json } from './types.ts';
import type { TaskStore } from './store.ts';

/**
 * Artifact ownership and commit review references (Issue #1 §13.6, §2, §9).
 *
 * Two facts the kernel must hold that a generic artifact store cannot:
 *
 *   - a CODE artifact points at a stable commit, with its repository and — when the
 *     work was actually done in one — the worktree it is reachable from. The
 *     worktree is an access location, the commit is the identity (§2), so a moved or
 *     deleted worktree never changes what was reviewed;
 *   - an approval is evidence about ONE commit. "This commit passed review" and
 *     "the current commit passed review" are different sentences, and the only way
 *     to keep them apart is to compare, at read time, the commit a review names
 *     against the commit the artifact version now carries (§14: 旧 commit 审查不会
 *     证明新 commit). A review is therefore never rewritten or deleted when a new
 *     commit lands: it becomes superseded evidence, and it stays readable.
 *
 * Artifacts published from inside a subgraph record the full stable path, so a
 * top-level artifact can be traced back to the instance that produced it (§9).
 *
 * This module records provenance; it does not decide acceptance. The Git acceptance
 * gate stays where it is (§13.6).
 */

/** A stable code reference: the commit is the identity, the worktree only a location. */
export interface CodeRef {
  repository: string;
  commit: string;
  /** Where the commit is checked out right now; optional and not part of identity. */
  worktree?: string;
}

export interface ArtifactRefRecord {
  graphId: string;
  /** Stable node path, e.g. `build/reviewer` for a node inside the `build` subgraph. */
  nodePath: string;
  /** The subgraph instance this artifact came from, or null at the top level. */
  subgraphPath: string | null;
  version: number;
  digest: string;
  /** Present for code artifacts, null for reports and other non-code outputs. */
  code: CodeRef | null;
  title: string | null;
  createdAt: number;
}

export interface ReviewRecord {
  id: string;
  graphId: string;
  artifactVersion: number;
  reviewedCommit: string;
  passed: boolean;
  reviewer: string;
  /** True when `reviewedCommit` is the commit this artifact version carries NOW. */
  isCurrentCommit: boolean;
  createdAt: number;
}

export interface ReviewEvidence {
  /** The approval that stands for this version as it is now, or null. */
  current: ReviewRecord | null;
  /** Approvals about an earlier commit: kept, readable, and not evidence. */
  superseded: ReviewRecord[];
}

export function codeRef(input: { repository: string; commit: string; worktree?: string }): CodeRef {
  if (!input.repository.trim()) throw new RuntimeError('invalid_code_ref', 'A code reference requires a repository');
  if (!input.commit.trim()) throw new RuntimeError('invalid_code_ref', 'A code reference requires a commit; a code artifact must name the exact version it is');
  return {
    repository: input.repository,
    commit: input.commit.trim(),
    ...(input.worktree ? { worktree: input.worktree } : {}),
  };
}

/** Report on what was reviewed. Deliberately says nothing about acceptance (§13.6). */
export function reviewEvidence(input: { graphId: string; artifactVersion: number }, provenance: ArtifactProvenance): { evidenceCurrent: boolean; reviewedCommit: string | null } {
  const evidence = provenance.reviewEvidenceFor(input.graphId, input.artifactVersion);
  return { evidenceCurrent: evidence.current !== null, reviewedCommit: evidence.current?.reviewedCommit ?? null };
}

export class ArtifactProvenance {
  private readonly db;
  private readonly store: TaskStore;
  constructor(store: TaskStore) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kernel_artifacts(
        graph_id TEXT NOT NULL, node_path TEXT NOT NULL, version INTEGER NOT NULL,
        subgraph_path TEXT, digest TEXT NOT NULL, code TEXT, title TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(graph_id,node_path,version));
      CREATE TABLE IF NOT EXISTS kernel_reviews(
        id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, node_path TEXT NOT NULL,
        artifact_version INTEGER NOT NULL, reviewed_commit TEXT NOT NULL,
        passed INTEGER NOT NULL, reviewer TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS kernel_reviews_target ON kernel_reviews(graph_id,node_path,artifact_version);
    `);
  }

  private insert(input: {
    graphId: string; nodePath: string; subgraphPath: string | null;
    version: number; digest: string; code: CodeRef | null; title: string | null;
  }): ArtifactRefRecord {
    if (input.version < 1) throw new RuntimeError('invalid_artifact', 'An artifact version starts at 1');
    const existing = this.db.prepare('SELECT 1 FROM kernel_artifacts WHERE graph_id=? AND node_path=? AND version=?')
      .get(input.graphId, input.nodePath, input.version);
    if (existing) throw new RuntimeError('invalid_artifact', `Artifact version ${input.version} already exists and is immutable`);
    const createdAt = Date.now();
    this.db.prepare(`INSERT INTO kernel_artifacts(graph_id,node_path,version,subgraph_path,digest,code,title,created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(input.graphId, input.nodePath, input.version, input.subgraphPath, input.digest,
        input.code ? JSON.stringify(input.code) : null, input.title, createdAt);
    return { ...input, createdAt };
  }

  /** Publish a code artifact: it must name the exact commit it is. */
  publishCode(input: {
    graphId: string; nodePath: string; subgraphPath?: string | null;
    code: CodeRef; version: number; digest: string; title?: string | null;
  }): ArtifactRefRecord {
    const code = codeRef(input.code);
    return this.insert({ ...input, subgraphPath: input.subgraphPath ?? null, code, title: input.title ?? null });
  }

  /** Publish a non-code artifact (a report, a plan, a source list): no commit. */
  publishReport(input: {
    graphId: string; nodePath: string; subgraphPath?: string | null;
    version: number; digest: string; title?: string | null;
  }): ArtifactRefRecord {
    return this.insert({ ...input, subgraphPath: input.subgraphPath ?? null, code: null, title: input.title ?? null });
  }

  private row(graphId: string, nodePath: string, version: number): ArtifactRefRecord | null {
    const row = this.db.prepare('SELECT * FROM kernel_artifacts WHERE graph_id=? AND node_path=? AND version=?')
      .get(graphId, nodePath, version) as
      { graph_id: string; node_path: string; version: number; subgraph_path: string | null; digest: string; code: string | null; title: string | null; created_at: number } | undefined;
    if (!row) return null;
    return {
      graphId: row.graph_id, nodePath: row.node_path, subgraphPath: row.subgraph_path,
      version: row.version, digest: row.digest,
      code: row.code ? JSON.parse(row.code) as CodeRef : null,
      title: row.title, createdAt: row.created_at,
    };
  }

  /** Every published version of one node path, oldest first. */
  versions(graphId: string, nodePath: string): ArtifactRefRecord[] {
    const rows = this.db.prepare('SELECT version FROM kernel_artifacts WHERE graph_id=? AND node_path=? ORDER BY version')
      .all(graphId, nodePath) as { version: number }[];
    return rows.map(row => this.row(graphId, nodePath, row.version)!);
  }

  /** Read one exact version; an old reference keeps resolving to its own commit and digest. */
  codeRefAt(graphId: string, version: number, nodePath = 'worker'): ArtifactRefRecord | null {
    return this.row(graphId, nodePath, version);
  }

  /**
   * Record what a reviewer looked at. A review must name a commit, and that commit is
   * compared against the artifact's commit at READ time — never stamped on write — so
   * a later commit cannot silently inherit an earlier approval.
   */
  recordReview(input: {
    graphId: string; nodePath?: string; artifactVersion: number;
    reviewedCommit: string; passed: boolean; reviewer: string;
  }): ReviewRecord {
    const nodePath = input.nodePath ?? 'worker';
    const artifact = this.row(input.graphId, nodePath, input.artifactVersion);
    if (!artifact) throw new RuntimeError('invalid_review', `Unknown artifact ${input.graphId}/${nodePath}@${input.artifactVersion}`);
    if (!artifact.code) {
      throw new RuntimeError('invalid_review', `Artifact ${input.graphId}/${nodePath}@${input.artifactVersion} is not a code artifact, so a commit review cannot apply`);
    }
    if (!input.reviewedCommit.trim()) throw new RuntimeError('invalid_review', 'A review must name the commit it reviewed');
    const id = `rev-${input.graphId}-${nodePath}-${input.artifactVersion}-${input.reviewer}-${Date.now().toString(36)}`;
    this.db.prepare(`INSERT INTO kernel_reviews(id,graph_id,node_path,artifact_version,reviewed_commit,passed,reviewer,created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, input.graphId, nodePath, input.artifactVersion, input.reviewedCommit.trim(), input.passed ? 1 : 0, input.reviewer, Date.now());
    return {
      id, graphId: input.graphId, artifactVersion: input.artifactVersion,
      reviewedCommit: input.reviewedCommit.trim(), passed: input.passed, reviewer: input.reviewer,
      isCurrentCommit: artifact.code.commit === input.reviewedCommit.trim(), createdAt: Date.now(),
    };
  }

  /** All reviews of one artifact version, newest last; each marked current or superseded. */
  reviewsFor(graphId: string, artifactVersion: number, nodePath = 'worker'): ReviewRecord[] {
    const artifact = this.row(graphId, nodePath, artifactVersion);
    const commit = artifact?.code?.commit;
    const rows = this.db.prepare('SELECT * FROM kernel_reviews WHERE graph_id=? AND node_path=? AND artifact_version=? ORDER BY created_at')
      .all(graphId, nodePath, artifactVersion) as
      { id: string; graph_id: string; artifact_version: number; reviewed_commit: string; passed: number; reviewer: string; created_at: number }[];
    return rows.map(row => ({
      id: row.id, graphId: row.graph_id, artifactVersion: row.artifact_version,
      reviewedCommit: row.reviewed_commit, passed: row.passed === 1, reviewer: row.reviewer,
      isCurrentCommit: commit !== undefined && commit === row.reviewed_commit, createdAt: row.created_at,
    }));
  }

  /**
   * The evidence that stands for a version as it is now: an approval whose commit is
   * still the artifact's commit. Approvals of an earlier commit are kept apart and
   * reported as superseded rather than discarded (§14).
   */
  reviewEvidenceFor(graphId: string, artifactVersion: number, nodePath = 'worker'): ReviewEvidence {
    const reviews = this.reviewsFor(graphId, artifactVersion, nodePath);
    const current = reviews.filter(r => r.isCurrentCommit && r.passed).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    const superseded = reviews.filter(r => !r.isCurrentCommit);
    return { current, superseded };
  }
}

/** Convenience: the JSON view a node sees when it inspects its own provenance. */
export function provenanceView(record: ArtifactRefRecord): Json {
  return {
    graphId: record.graphId,
    nodePath: record.nodePath,
    subgraphPath: record.subgraphPath,
    version: record.version,
    digest: record.digest,
    commit: record.code?.commit ?? null,
    repository: record.code?.repository ?? null,
    worktree: record.code?.worktree ?? null,
    title: record.title,
  } as unknown as Json;
}
