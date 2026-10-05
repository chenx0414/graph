import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { taskBranchName, taskWorktreeDirName, uniqueWorktreeDirName, workCopyBranchName } from '../core/branch-naming.ts';
import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json, type NodeSpec, type Operation } from '../core/types.ts';
import { loadGraph, resetIdleNode } from '../core/graph.ts';
import {
  abortMerge, commitAll, commitBaseline, detectRepo, directoryFingerprint, ensureWorktree, fastForwardCheckout, git,
  hasHead, initRepo, isClean, mergeConflictFiles, mergeRef, pathInside, repoFingerprint, resetHard, revParse, scopedDirty, updateRef, worktreeList,
  checkedOutBranch, projectPathEntries, type GitIdentity,
} from './git.ts';

interface PreparationFields {
  repoRoot?: string | null | undefined; projectSubdir?: string | null | undefined; branch?: string | null | undefined;
  baselineSha?: string | null | undefined; detail?: Json | null | undefined;
}

/**
 * A node has to run again once the integration commit moves on. Program checks recompute evidence
 * that is bound to the integration sha, and a judging agent node (a review) read that sha when it
 * ran: keeping its verdict lets the gate consume a report about code that is no longer there, which
 * is how a reworked lane ends up stuck behind a stale blocker. A work lane keeps its own commits,
 * so it is never re-checked here.
 */
export function rechecksAfterIntegrationChange(spec: NodeSpec, status: string): boolean {
  if (status !== 'succeeded') return false;
  return spec.kind === 'program' || spec.action === 'review';
}

/**
 * Which succeeded checks actually have to run again after an integration advance.
 *
 * `rechecksAfterIntegrationChange` answers "would this kind of node re-check at all"; this answers
 * "did the advance touch what this node judged". An advance that only adds a sibling lane's file
 * changes the integration sha, but nothing this node depends on moved, so re-running it spends a
 * whole review turn to reach the same verdict (measured: an unrelated lane's merge reset every
 * review in the task, and round stayed 1 each time - they never really reworked).
 *
 * A node is stale when the changed paths intersect its own dependency closure's produced paths:
 * the files its upstream nodes wrote plus its own output. When either side is unknown the node is
 * treated as stale - re-running a node that did not need it costs tokens, but skipping one that did
 * would let a verdict about code that is no longer there stand, which is the failure this guard exists
 * to prevent.
 */
export function staleRecheckTargets(input: {
  /** Repo-relative paths the integration advance touched; null when the diff could not be computed. */
  changedPaths: readonly string[] | null;
  /** Nodes eligible to re-check, in any order. */
  candidates: readonly { id: string; closurePaths: readonly string[] }[];
}): Set<string> {
  const stale = new Set<string>();
  for (const candidate of input.candidates) {
    // Unknown on either side means we cannot prove the node is unaffected, so it re-checks.
    if (input.changedPaths === null || candidate.closurePaths.length === 0) { stale.add(candidate.id); continue; }
    const touched = candidate.closurePaths.some(path => input.changedPaths!.some(changed => sameTreePath(changed, path)));
    if (touched) stale.add(candidate.id);
  }
  return stale;
}

/** Two repo paths name the same thing: equal, or one is a directory prefix of the other. */
function sameTreePath(a: string, b: string): boolean {
  const x = a.replace(/^\.\//, '').replace(/\/+$/, '');
  const y = b.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

const EVIDENCE_PREFIXES = ['evidence/'];

/**
 * A lane owns the paths its node declares and nothing else. A work copy that also carries a sibling
 * lane's file merges as a conflict, or silently rewrites work it does not own, so those paths are
 * put back to the integration tip before the merge - the recovery the worker rule asks a human for,
 * done deterministically. Content from outside the scope is never adopted. A node's own evidence
 * directory is its submission material, never a sibling's file.
 */
export function outOfScopePaths(changed: readonly string[], scope: readonly string[]): string[] {
  return changed.filter(path => !EVIDENCE_PREFIXES.some(prefix => path.startsWith(prefix))
    && !scope.some(owned => path === owned || path.startsWith(owned.endsWith('/') ? owned : `${owned}/`)));
}

/** Task integration branch and per-instance work copies. Git effects stay outside SQLite transactions. */
export class GitIntegration {
  private readonly store: TaskStore;
  private readonly stateDir: string;
  private readonly repos = new Map<string, string | undefined>();
  private readonly tails = new Map<string, Promise<void>>();
  constructor(store: TaskStore, stateDir: string) { this.store = store; this.stateDir = stateDir; }

  exclusive<T>(taskId: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    const current = previous.then(action, action);
    this.tails.set(taskId, current.then(() => undefined, () => undefined));
    return current;
  }

  repoRoot(taskId: string) {
    const task = this.store.task(taskId);
    const cached = this.repos.get(task.project_id);
    if (cached) return cached;
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string };
    const root = detectRepo(project.root);
    // Only positive detection is cached: a project that becomes a repository
    // after initialization must not stay negative forever.
    if (root) this.repos.set(task.project_id, root);
    return root;
  }

  preparation(projectId: string) {
    const row = this.store.db.prepare('SELECT * FROM project_preparation WHERE project_id=?').get(projectId) as {
      project_id: string; state: string; repo_root: string | null; project_subdir: string | null;
      branch: string | null; baseline_sha: string | null; detail: string | null; updated_at: number;
    } | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id, state: row.state, repoRoot: row.repo_root, projectSubdir: row.project_subdir,
      branch: row.branch, baselineSha: row.baseline_sha, detail: row.detail ? JSON.parse(row.detail) as Json : null, updatedAt: row.updated_at,
    };
  }

  /** Read-only project paths for chat @-references. */
  visiblePaths(projectId: string, query = '', limit = 80) {
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(projectId) as { root: string } | undefined;
    if (!project) throw new RuntimeError('not_found', `Unknown project ${projectId}`);
    return projectPathEntries(project.root, { stateDir: this.stateDir, query, limit });
  }

  private recordPreparation(projectId: string, state: string, fields: PreparationFields = {}) {
    // Single-statement write: callers may already hold the store transaction
    // (the projects command) or run outside one (formal-dispatch preflight).
    this.store.db.prepare(`INSERT OR REPLACE INTO project_preparation(project_id,state,repo_root,project_subdir,branch,baseline_sha,detail,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(projectId, state, fields.repoRoot ?? null, fields.projectSubdir ?? null, fields.branch ?? null,
        fields.baselineSha ?? null, fields.detail === undefined || fields.detail === null ? null : canonicalJson(fields.detail), Date.now());
  }

  /** Scoped, exclusion-aware preparation. A plain directory is initialized on
   * explicit prepare or before a formal dispatch; an existing dirty repository
   * is reported, never silently committed into the user's index. */
  prepareProject(projectId: string, input: { initialize?: boolean; createBaseline?: boolean } = {}) {
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(projectId) as { root: string } | undefined;
    if (!project) throw new RuntimeError('not_found', `Unknown project ${projectId}`);
    // Canonicalize so a symlinked temp path cannot turn into a bogus
    // repository-relative subdirectory.
    const root = (() => { try { return realpathSync(resolve(project.root)); } catch { return resolve(project.root); } })();
    const repo = detectRepo(root);
    if (!repo) {
      if (!input.initialize) {
        this.recordPreparation(projectId, 'detected', { detail: { reason: 'not_a_repository' } });
        return this.preparation(projectId)!;
      }
      this.recordPreparation(projectId, 'initializing', {});
      try {
        initRepo(root);
        const baselineSha = commitBaseline(root, 'graph: local baseline', { stateDir: this.stateDir });
        this.repos.set(projectId, root);
        this.recordPreparation(projectId, 'ready', {
          repoRoot: root, projectSubdir: '', branch: checkedOutBranch(root) ?? null, baselineSha,
          detail: { initialized: true, baselineCreated: true, fingerprint: repoFingerprint(root, { stateDir: this.stateDir }) },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.recordPreparation(projectId, 'failed', { detail: { reason } });
        throw new RuntimeError('project_prepare_failed', `Failed to initialize Git in ${root}: ${reason}`);
      }
      return this.preparation(projectId)!;
    }
    const subdir = relative(repo, root).split(sep).join('/').replace(/^\.$/, '');
    this.repos.set(projectId, repo);
    const scope = { subdir, stateDir: this.stateDir };
    const record = (state: string, extra: Record<string, Json>) => {
      this.recordPreparation(projectId, state, {
        repoRoot: repo, projectSubdir: subdir, branch: checkedOutBranch(repo) ?? null,
        baselineSha: revParse(repo, 'HEAD') ?? null,
        detail: { ...extra, fingerprint: repoFingerprint(repo, scope) },
      });
      return this.preparation(projectId)!;
    };
    if (!hasHead(repo)) {
      this.recordPreparation(projectId, 'initializing', { repoRoot: repo, projectSubdir: subdir });
      try {
        commitBaseline(repo, 'graph: local baseline', scope);
        return record('ready', { initialized: false, baselineCreated: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.recordPreparation(projectId, 'failed', { repoRoot: repo, projectSubdir: subdir, detail: { reason } });
        throw new RuntimeError('project_prepare_failed', `Failed to create a Git baseline in ${repo}: ${reason}`);
      }
    }
    // Host-managed paths are relative to the project root; when the project is
    // a repository subdirectory they may also sit under the repository root.
    const dirty = scopedDirty(repo, scope);
    if (dirty.length && input.createBaseline) {
      this.recordPreparation(projectId, 'initializing', { repoRoot: repo, projectSubdir: subdir });
      try {
        commitBaseline(repo, 'graph: local baseline', scope);
        return record('ready', { dirty: dirty.length, baselineCreated: true, sample: dirty.slice(0, 20) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.recordPreparation(projectId, 'failed', { repoRoot: repo, projectSubdir: subdir, detail: { reason } });
        throw new RuntimeError('project_prepare_failed', `Failed to create a Git baseline in ${repo}: ${reason}`);
      }
    }
    return record(dirty.length ? 'detected' : 'ready', dirty.length ? { dirty: dirty.length, sample: dirty.slice(0, 20) } : { dirty: 0 });
  }

  /** Current HEAD of the project's repository (null when absent/uninitialized). */
  projectHead(projectId: string) {
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(projectId) as { root: string } | undefined;
    if (!project) return null;
    const root = (() => { try { return realpathSync(resolve(project.root)); } catch { return resolve(project.root); } })();
    const repo = detectRepo(root);
    if (!repo) return null;
    return revParse(repo, 'HEAD') ?? null;
  }

  /** Content-aware fingerprint used to decide whether an interrupted baseline
   * may be replayed (same worktree) or must be surfaced as unresolved. */
  projectFingerprint(projectId: string) {
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(projectId) as { root: string } | undefined;
    if (!project) return null;
    const root = (() => { try { return realpathSync(resolve(project.root)); } catch { return resolve(project.root); } })();
    const repo = detectRepo(root);
    // A plain directory still gets a meaningful content fingerprint: crash
    // recovery must not treat "no repository" as "unchanged".
    if (!repo) return directoryFingerprint(root, { stateDir: this.stateDir });
    const subdir = relative(repo, root).split(sep).join('/').replace(/^\.$/, '');
    return repoFingerprint(repo, { subdir, stateDir: this.stateDir });
  }

  /** Last commit subject/parents, used to recognize our own concluded effect. */
  lastCommit(projectId: string) {
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(projectId) as { root: string } | undefined;
    if (!project) return null;
    const root = (() => { try { return realpathSync(resolve(project.root)); } catch { return resolve(project.root); } })();
    const repo = detectRepo(root);
    if (!repo || !hasHead(repo)) return null;
    const subject = git(repo, ['log', '-1', '--format=%s']).stdout;
    const parents = git(repo, ['log', '-1', '--format=%P']).stdout.split(' ').filter(Boolean);
    return { subject, parents };
  }

  markPrepareUnresolved(projectId: string, reason: string) {
    this.recordPreparation(projectId, 'failed', { projectSubdir: this.preparation(projectId)?.projectSubdir ?? null, detail: { reason } });
  }

  /** Re-check the recorded readiness against the current repository at every
   * boundary; a stale `ready` snapshot never authorizes dispatch. */
  private refreshPrepared(projectId: string) {
    const prep = this.preparation(projectId);
    if (!prep || prep.state === 'initializing' || prep.state === 'failed') return this.prepareProject(projectId, { initialize: true });
    if (prep.state !== 'ready' && prep.state !== 'detected') return prep;
    if (!prep.repoRoot) return this.prepareProject(projectId, {});
    const current = repoFingerprint(prep.repoRoot, { subdir: prep.projectSubdir ?? '', stateDir: this.stateDir });
    const recorded = prep.state === 'ready' || prep.state === 'detected'
      ? (prep.detail as { fingerprint?: string } | null)?.fingerprint
      : undefined;
    if (recorded === current) return prep;
    // The snapshot is stale (dirty, new commit, branch switch, deletion).
    return this.prepareProject(projectId, {});
  }

  /** Auto-prepare a plain directory and require a ready, clean Git project;
   * used before formal dispatch and before binding a conversation to a project. */
  requirePrepared(projectId: string) {
    const prep = this.refreshPrepared(projectId);
    if (prep.state !== 'ready') {
      const reason = (prep.detail as { reason?: string } | null)?.reason;
      if (reason === 'not_a_repository') throw new RuntimeError('git_required', `Project ${projectId} is not a Git repository; prepare it from the console first`);
      if (prep.state === 'failed') throw new RuntimeError('project_prepare_failed', `Project ${projectId} Git preparation failed`);
      throw new RuntimeError('project_dirty', `Project ${projectId} has uncommitted changes; review them and create a local baseline before dispatch`);
    }
    return prep;
  }

  /** Preflight for formal acceptance: the project must be ready and the
   * target branch must exist before any official state is committed. */
  requireTargetBranch(projectId: string, branch: string) {
    const prep = this.requirePrepared(projectId);
    if (!revParse(prep.repoRoot!, branch)) throw new RuntimeError('invalid_input', `Unknown target branch ${branch}`);
    return prep;
  }

  prepareTask(taskId: string, targetBranch: string) {
    const task = this.store.task(taskId);
    const prep = this.requirePrepared(task.project_id);
    const repo = prep.repoRoot!;
    const targetSha = revParse(repo, targetBranch);
    if (!targetSha) throw new RuntimeError('invalid_input', `Unknown target branch ${targetBranch}`);
    const branch = taskBranchName(task.request, taskId);
    const integrationPath = join(this.stateDir, 'worktrees', taskWorktreeDirName(task.request, taskId), 'integration');
    ensureWorktree(repo, integrationPath, branch, targetSha);
    const sha = revParse(integrationPath, 'HEAD') ?? targetSha;
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE tasks SET integration_branch=?,integration_sha=?,target_sha=? WHERE id=?')
        .run(branch, sha, targetSha, taskId);
      this.store.db.prepare('INSERT OR REPLACE INTO worktrees VALUES(?,?,?,?,?)')
        .run(`integration:${taskId}`, taskId, 'integration', integrationPath, branch);
      this.store.event(taskId, 'git.prepared', { branch, targetBranch, targetSha });
    });
  }

  /** Completed tasks release scratch checkouts but retain their integration branch.
   * Rework restores that exact tip before admitting any worker or check. */
  private ensureIntegrationWorkspace(taskId: string) {
    const task = this.store.task(taskId);
    if (!task.integration_branch || !['running', 'queued'].includes(task.phase)) return;
    if (this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`)) return;
    const repo = this.repoRoot(taskId);
    if (!repo) return;
    const path = join(this.stateDir, 'worktrees', taskWorktreeDirName(task.request, taskId), 'integration');
    const tip = task.integration_sha ?? revParse(repo, task.integration_branch);
    if (!tip) throw new RuntimeError('invalid_state', 'Task integration commit is unavailable');
    ensureWorktree(repo, path, task.integration_branch, tip);
    this.store.db.prepare('INSERT INTO worktrees VALUES(?,?,?,?,?)')
      .run(`integration:${taskId}`, taskId, 'integration', path, task.integration_branch);
  }

  workspace(taskId: string, instanceId: string | null, nodeId: string, kind: NodeSpec['kind'], action?: NodeSpec['action']) {
    this.ensureIntegrationWorkspace(taskId);
    const task = this.store.task(taskId);
    if (!task.integration_branch) return;
    const repo = this.repoRoot(taskId);
    if (!repo) return;
    // A project that is a repository subdirectory keeps its scope: workers and
    // checks start inside that subdirectory while the worktree covers the repo.
    const subdir = this.preparation(task.project_id)?.projectSubdir ?? '';
    if (kind !== 'agent' || !instanceId) {
      const row = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`) as { path: string } | undefined;
      return row?.path ? (subdir ? join(row.path, subdir) : row.path) : undefined;
    }
    const existing = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(instanceId) as { path: string } | undefined;
    if (existing) {
      // A node that judges the integration (review) must read the current tip, not the tree its work
      // copy was first seeded with: a reworked lane advances the integration, and reusing the old tree
      // made the reviewer restate stale findings until the gate stalled. Work lanes keep their own
      // commits across retries, so only non-work nodes are re-seeded.
      if (action && action !== 'work') {
        const tip = task.integration_sha ?? revParse(repo, task.integration_branch)!;
        const head = revParse(existing.path, 'HEAD');
        if (tip && head !== tip) {
          resetHard(existing.path, tip);
          this.store.event(taskId, 'git.workcopy.reseeded', { nodeId, from: head, to: tip });
        }
      }
      return subdir ? join(existing.path, subdir) : existing.path;
    }
    const branch = workCopyBranchName(task.request, taskId, nodeId);
    const root = join(this.stateDir, 'worktrees', taskWorktreeDirName(task.request, taskId));
    const taken = new Set<string>();
    for (const row of this.store.db.prepare('SELECT path FROM worktrees WHERE task_id=?').all(taskId) as { path: string }[]) {
      taken.add(basename(row.path));
    }
    if (existsSync(root)) for (const entry of readdirSync(root)) taken.add(entry);
    const path = join(root, uniqueWorktreeDirName(nodeId, taken));
    const start = task.integration_sha ?? revParse(repo, task.integration_branch)!;
    ensureWorktree(repo, path, branch, start);
    this.store.db.prepare('INSERT OR IGNORE INTO worktrees VALUES(?,?,?,?,?)').run(instanceId, taskId, nodeId, path, branch);
    return subdir ? join(path, subdir) : path;
  }

  private agentIdentity(instanceId: string | null, nodeId: string): GitIdentity {
    const row = instanceId
      ? this.store.db.prepare(`SELECT i.definition_version,d.spec FROM instances i
          LEFT JOIN definitions d ON d.id=substr(i.definition_version,1,instr(i.definition_version,'@')-1)
            AND d.version=CAST(substr(i.definition_version,instr(i.definition_version,'@')+1) AS INTEGER)
          WHERE i.id=?`).get(instanceId) as { definition_version: string | null; spec: string | null } | undefined
      : undefined;
    const definitionVersion = row?.definition_version ?? nodeId;
    const definitionId = definitionVersion.split('@')[0] || nodeId;
    let name = definitionId;
    if (row?.spec) {
      try {
        const spec = JSON.parse(row.spec) as { snapshot?: { agentCombination?: { name?: unknown }; name?: unknown } };
        const candidate = spec.snapshot?.agentCombination?.name ?? spec.snapshot?.name;
        if (typeof candidate === 'string' && candidate.trim()) name = candidate.trim();
      } catch {
        // A malformed historical definition falls back to its stable id.
      }
    }
    const slug = definitionId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    return { name, email: `${slug}@agents.graph.local` };
  }

  integrate(operation: Pick<Operation, 'id' | 'taskId' | 'nodeId' | 'instanceId' | 'kind'>) {
    if (!operation.instanceId || operation.kind !== 'agent') return;
    const task = this.store.task(operation.taskId);
    if (!task.integration_branch) return;
    const tree = this.store.db.prepare('SELECT path,branch FROM worktrees WHERE instance_id=?').get(operation.instanceId) as { path: string; branch: string } | undefined;
    const integration = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${operation.taskId}`) as { path: string } | undefined;
    if (!tree || !integration) return;
    const identity = this.agentIdentity(operation.instanceId, operation.nodeId);
    const sha = commitAll(tree.path, `graph:${operation.nodeId}:${operation.id}`, identity);
    if (sha) this.store.db.prepare('INSERT INTO git_commits VALUES(?,?,?,?,?)').run(sha, operation.taskId, operation.nodeId, operation.id, 'instance');
    // The base a lane's out-of-scope paths are restored to is the integration tip. On the first
    // lane of a task `integration_sha` is still null, and reading only that column silently skipped
    // the scope restore - so a lane's stray file would land. The branch tip is the same fact.
    const base = task.integration_sha ?? revParse(integration.path, 'HEAD') ?? null;
    this.restoreOutOfScope(tree, base, operation, identity);
    const merged = mergeRef(integration.path, tree.branch);
    if (!merged.ok) return merged;
    let rebases: { path: string; sha: string }[] = [];
    this.store.transaction(() => {
      const previous = this.store.task(operation.taskId).integration_sha;
      this.store.db.prepare('UPDATE tasks SET integration_sha=? WHERE id=?').run(merged.sha, operation.taskId);
      this.store.db.prepare('INSERT INTO git_commits VALUES(?,?,?,?,?)').run(merged.sha, operation.taskId, operation.nodeId, operation.id, 'integration');
      if (previous && previous !== merged.sha && !this.retargetEvidence(operation.taskId, previous, merged.sha)) rebases = this.invalidateChecks(operation.taskId, previous, merged.sha);
    });
    for (const rebase of rebases) resetHard(rebase.path, rebase.sha);
    return merged;
  }

  tryDeliver(taskId: string): { status: 'skip' | 'merged' | 'blocked' | 'recheck'; data?: Json } {
    const task = this.store.task(taskId);
    if (!task.integration_branch || !task.target_branch) return { status: 'skip' };
    const repo = this.repoRoot(taskId);
    if (!repo) return { status: 'skip' };
    const integration = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`) as { path: string } | undefined;
    if (!integration) return { status: 'blocked', data: { reason: 'Missing integration worktree' } };
    const integrationSha = revParse(integration.path, 'HEAD');
    const targetSha = revParse(repo, task.target_branch);
    if (!integrationSha || !targetSha) return { status: 'blocked', data: { reason: 'Missing git refs' } };
    if (targetSha === integrationSha) {
      this.store.db.prepare('UPDATE tasks SET target_sha=? WHERE id=?').run(integrationSha, taskId);
      return { status: 'merged' };
    }
    if (task.target_sha && targetSha !== task.target_sha) return this.recheckAgainstTarget(taskId, integration.path, task.target_branch, targetSha);
    const opId = randomUUID();
    this.store.db.prepare('INSERT INTO git_ops VALUES(?,?,?,?,?,?)')
      .run(opId, taskId, 'deliver', 'dispatched', canonicalJson({ integrationSha, targetSha }), null);
    const checkouts = worktreeList(repo).filter(tree => tree.branch === task.target_branch);
    if (checkouts.length) {
      for (const target of checkouts) {
        const ignore = pathInside(target.path, this.stateDir) ? [this.stateDir] : [];
        if (!isClean(target.path, ignore)) {
          this.store.db.prepare("UPDATE git_ops SET state='blocked',result=? WHERE id=?").run(canonicalJson({ kind: 'git_dirty' }), opId);
          return { status: 'blocked', data: { kind: 'git_dirty', reason: 'Target worktree is dirty' } };
        }
      }
      for (const target of checkouts) {
        const forwarded = fastForwardCheckout(target.path, integrationSha);
        if (!forwarded.ok) {
          this.store.db.prepare("UPDATE git_ops SET state='failed',result=? WHERE id=?").run(canonicalJson({ stderr: forwarded.stderr }), opId);
          return this.recheckAgainstTarget(taskId, integration.path, task.target_branch, revParse(repo, task.target_branch) ?? targetSha);
        }
      }
    } else {
      const updated = updateRef(repo, `refs/heads/${task.target_branch}`, integrationSha, targetSha);
      if (!updated.ok) {
        this.store.db.prepare("UPDATE git_ops SET state='failed',result=? WHERE id=?").run(canonicalJson({ stderr: updated.stderr }), opId);
        return this.recheckAgainstTarget(taskId, integration.path, task.target_branch, revParse(repo, task.target_branch) ?? targetSha);
      }
    }
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE tasks SET target_sha=? WHERE id=?').run(integrationSha, taskId);
      this.store.db.prepare("UPDATE git_ops SET state='succeeded',result=? WHERE id=?").run(canonicalJson({ sha: integrationSha }), opId);
    });
    return { status: 'merged' };
  }

  restore(taskId: string) {
    const task = this.store.task(taskId);
    if (!task.target_branch || !['running', 'queued'].includes(task.phase)) return;
    if (!task.integration_branch) this.prepareTask(taskId, task.target_branch);
    this.ensureIntegrationWorkspace(taskId);
    const repo = this.repoRoot(taskId);
    if (!repo) return;
    const integration = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`) as { path: string } | undefined;
    if (integration) abortMerge(integration.path);
    const head = integration ? revParse(integration.path, 'HEAD') : undefined;
    const current = this.store.task(taskId);
    if (head && current.integration_sha && head !== current.integration_sha) {
      this.store.db.prepare('UPDATE tasks SET integration_sha=? WHERE id=?').run(head, taskId);
    }
    if (current.phase !== 'running' || !current.integration_branch || !current.target_branch) return;
    const targetSha = revParse(repo, current.target_branch);
    const integrationSha = head;
    if (targetSha && integrationSha && targetSha === integrationSha) {
      this.store.db.prepare("UPDATE git_ops SET state='succeeded' WHERE task_id=? AND kind='deliver' AND state IN ('intent','dispatched')").run(taskId);
      this.store.db.prepare('UPDATE tasks SET target_sha=? WHERE id=?').run(integrationSha, taskId);
      return { status: 'merged' as const };
    }
  }

  private recheckAgainstTarget(taskId: string, integrationPath: string, targetBranch: string, targetSha: string) {
    const before = revParse(integrationPath, 'HEAD');
    const moved = mergeRef(integrationPath, targetBranch);
    if (!moved.ok) return { status: 'blocked' as const, data: { kind: 'git_conflict', conflicts: moved.conflicts, reason: 'Target branch changed' } as Json };
    let rebases: { path: string; sha: string }[] = [];
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE tasks SET integration_sha=?,target_sha=? WHERE id=?').run(moved.sha, targetSha, taskId);
      rebases = before && before !== moved.sha && this.retargetEvidence(taskId, before, moved.sha) ? [] : this.invalidateChecks(taskId, before ?? null, moved.sha);
    });
    for (const rebase of rebases) resetHard(rebase.path, rebase.sha);
    return { status: 'recheck' as const };
  }

  /**
   * An integration advance that leaves the accepted tree byte-identical - a delivery fast-forward, a
   * rebase onto the same content - invalidates nothing. The evidence is re-bound to the new commit
   * and the graph keeps its acceptance, so the user is never asked to accept the same content twice
   * (the completion judgement compares evidence.commit_sha to the current integration sha, and a
   * stale sha would force the whole verification chain, human checks included, to run again).
   * A real content change still invalidates and re-runs exactly as before. Returns true when the
   * evidence was re-bound and no re-check is needed.
   */
  retargetEvidence(taskId: string, from: string, to: string): boolean {
    if (from === to) return true;
    const integration = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`) as { path: string } | undefined;
    const cwd = integration?.path ?? this.repoRoot(taskId);
    if (!cwd) return false;
    if (git(cwd, ['diff', '--quiet', from, to]).code !== 0) return false;
    const changed = this.store.db.prepare('UPDATE evidence SET commit_sha=? WHERE task_id=? AND commit_sha=?').run(to, taskId, from).changes;
    this.store.event(taskId, 'git.evidence.retargeted', { from, to, rows: changed });
    return true;
  }

  /** The node's declared file list, or null when it declared none. */
  private declaredScope(taskId: string, nodeId: string): string[] | null {
    const row = this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { spec: string } | undefined;
    if (!row) return null;
    let spec: NodeSpec;
    try { spec = JSON.parse(row.spec) as NodeSpec; } catch { return null; }
    const input = spec.input && typeof spec.input === 'object' && !Array.isArray(spec.input) ? spec.input as Record<string, unknown> : null;
    const files = input?.['files'];
    if (!Array.isArray(files) || !files.length) return null;
    return files.every(item => typeof item === 'string') ? files as string[] : null;
  }

  /** Put a lane's out-of-scope paths back to the integration tip before its branch is merged. */
  private restoreOutOfScope(tree: { path: string; branch: string }, base: string | null, operation: Pick<Operation, 'id' | 'taskId' | 'nodeId'>, identity: GitIdentity) {
    if (!base) return;
    const scope = this.declaredScope(operation.taskId, operation.nodeId);
    if (!scope) return;
    const changed = git(tree.path, ['diff', '--name-only', `${base}..HEAD`]);
    if (changed.code !== 0) return;
    const foreign = outOfScopePaths(changed.stdout.split('\n').map(line => line.trim()).filter(Boolean), scope);
    if (!foreign.length) return;
    // Only a path the base already has is restored. A file the lane created outside its scope cannot
    // be reverted by checkout, and deleting it would destroy submission material, so it is reported
    // instead of removed.
    const baseFiles = new Set(git(tree.path, ['ls-tree', '-r', '--name-only', base]).stdout.split('\n').map(line => line.trim()).filter(Boolean));
    const restorable = foreign.filter(path => baseFiles.has(path));
    const created = foreign.filter(path => !baseFiles.has(path));
    let sha: string | undefined;
    if (restorable.length) {
      if (git(tree.path, ['checkout', base, '--', ...restorable]).code !== 0) return;
      sha = commitAll(tree.path, `graph:${operation.nodeId}:${operation.id}:scope`, identity);
    }
    this.store.event(operation.taskId, 'git.out-of-scope.restored', { nodeId: operation.nodeId, restored: restorable, created, sha: sha ?? null });
  }

  private invalidateChecks(taskId: string, from: string | null, to: string | null) {
    // A task always has a graph revision in production, but a git-level caller must not crash inside
    // a transaction over a task that has none: the evidence is invalidated above, and there are no
    // succeeded nodes to re-run.
    let graph: ReturnType<typeof loadGraph>;
    try { graph = loadGraph(this.store, taskId); } catch { this.invalidateAllEvidence(taskId); return []; }

    // What this advance actually changed. Unknown means every eligible node re-checks, which is the
    // old (safe) behaviour.
    const changedPaths = this.changedPathsBetween(taskId, from, to);
    const candidates: { id: string; closurePaths: string[] }[] = [];
    for (const [id, spec] of graph.plan.nodes) {
      if (!rechecksAfterIntegrationChange(spec, graph.status(id))) continue;
      candidates.push({ id, closurePaths: this.closureProducedPaths(taskId, graph, id) });
    }
    const stale = staleRecheckTargets({ changedPaths, candidates });

    // A node whose closure did not move keeps its verdict; only re-bind its evidence to the new sha so
    // the completion judgement (which compares evidence.commit_sha to the integration sha) still holds.
    for (const candidate of candidates) {
      if (stale.has(candidate.id) || !to) continue;
      this.store.db.prepare('UPDATE evidence SET commit_sha=? WHERE task_id=? AND node_id=? AND valid=1').run(to, taskId, candidate.id);
    }
    for (const id of stale) this.store.db.prepare('UPDATE evidence SET valid=0 WHERE task_id=? AND node_id=? AND valid=1').run(taskId, id);

    const reset = new Set<string>(stale);
    for (const id of stale) {
      for (const dependent of graph.plan.dependents(id)) {
        if (!['preparing', 'running'].includes(graph.status(dependent))) reset.add(dependent);
      }
    }
    const task = this.store.task(taskId);
    const rebases: { path: string; sha: string }[] = [];
    for (const id of reset) {
      const result = resetIdleNode(this.store, taskId, id, task.graph_version);
      if (!result.reset) continue;
      if (result.instanceId && task.integration_sha) {
        const tree = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(result.instanceId) as { path: string } | undefined;
        if (tree) rebases.push({ path: tree.path, sha: task.integration_sha });
      }
    }
    this.store.event(taskId, 'git.recheck', { reason: 'Integration commit changed', reset: [...reset], rebased: candidates.filter(c => !stale.has(c.id)).map(c => c.id) });
    return rebases;
  }

  /** Every evidence row goes, the pre-HB-209 behaviour, used when the graph itself cannot be read. */
  private invalidateAllEvidence(taskId: string) {
    this.store.db.prepare('UPDATE evidence SET valid=0 WHERE task_id=? AND valid=1').run(taskId);
  }

  /** Repo-relative paths the advance `from..to` touched, or null when it cannot be computed. */
  private changedPathsBetween(taskId: string, from: string | null, to: string | null): string[] | null {
    if (!from || !to || from === to) return from === to ? [] : null;
    const integration = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`) as { path: string } | undefined;
    const cwd = integration?.path ?? this.repoRoot(taskId);
    if (!cwd) return null;
    const diff = git(cwd, ['diff', '--name-only', from, to]);
    if (diff.code !== 0) return null;
    return diff.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  }

  /**
   * The files a node's dependency closure wrote: its own output paths, then every ancestor's, so a
   * change anywhere upstream of this node counts as touching it.
   */
  private closureProducedPaths(taskId: string, graph: ReturnType<typeof loadGraph>, nodeId: string): string[] {
    const paths = new Set<string>();
    const seen = new Set<string>();
    const visit = (id: string) => {
      // A dependency may name a container; only its leaves produce files.
      for (const leaf of graph.plan.leaves(id)) {
        if (seen.has(leaf)) continue;
        seen.add(leaf);
        for (const path of this.producedPaths(taskId, leaf)) paths.add(path);
        for (const dependency of graph.plan.dependencies.get(leaf) ?? []) visit(dependency);
      }
    };
    visit(nodeId);
    return [...paths];
  }

  /** The repo-relative paths one node produced: its declared deliverable plus its submitted changes. */
  private producedPaths(taskId: string, nodeId: string): string[] {
    const paths = new Set<string>();
    const specRow = this.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { spec: string } | undefined;
    if (specRow) {
      try {
        const spec = JSON.parse(specRow.spec) as NodeSpec & { deliverable?: { path?: unknown } };
        if (typeof spec.deliverable?.path === 'string' && spec.deliverable.path.trim()) paths.add(spec.deliverable.path.trim());
      } catch { /* an unreadable spec leaves only the submitted changes as known output */ }
    }
    const row = this.store.db.prepare(`SELECT result FROM operations WHERE task_id=? AND node_id=? AND state='succeeded' ORDER BY rowid DESC LIMIT 1`).get(taskId, nodeId) as { result: string | null } | undefined;
    if (!row?.result) return [...paths];
    try {
      const result = JSON.parse(row.result) as { output?: { changes?: { path?: unknown }[] } };
      for (const change of result.output?.changes ?? []) {
        if (typeof change.path === 'string' && change.path.trim()) paths.add(change.path.trim());
      }
    } catch { /* a result we cannot read leaves the deliverable paths as the only known output */ }
    return [...paths];
  }

  /**
   * A terminal task keeps no working copies. They are scratch checkouts whose paths and copy
   * branches would otherwise accumulate for the lifetime of the state directory, because every
   * node of every task leaves one behind and nothing used to release them. The task's own
   * integration branch is kept for traceability; only its per-node `graph/copy/...` branches go.
   */
  releaseWorkcopies(taskId: string) {
    const rows = this.store.db.prepare('SELECT instance_id,path,branch FROM worktrees WHERE task_id=?')
      .all(taskId) as { instance_id: string; path: string; branch: string }[];
    if (!rows.length) return 0;
    const repo = this.repoRoot(taskId);
    if (!repo) return 0;
    let removed = 0;
    for (const row of rows) {
      if (row.path && git(repo, ['worktree', 'remove', '--force', row.path]).code === 0) removed += 1;
      // Only a per-node copy branch is deleted; the task branch is never touched.
      if (row.branch.startsWith('graph/copy/')) git(repo, ['branch', '-D', row.branch]);
    }
    git(repo, ['worktree', 'prune']);
    this.store.db.prepare('DELETE FROM worktrees WHERE task_id=?').run(taskId);
    this.store.event(taskId, 'git.workcopies.released', { registered: rows.length, removed });
    return rows.length;
  }

  /** Idempotent sweep for tasks that already reached a terminal phase. */
  sweepTerminalWorkcopies() {
    const rows = this.store.db.prepare(`SELECT DISTINCT w.task_id FROM worktrees w JOIN tasks t ON t.id=w.task_id
      WHERE t.phase IN ('completed','abandoned')`).all() as { task_id: string }[];
    for (const row of rows) this.releaseWorkcopies(row.task_id);
    return rows.length;
  }
}
