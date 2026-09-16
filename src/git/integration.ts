import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json, type NodeSpec, type Operation } from '../core/types.ts';
import { loadGraph, resetIdleNode } from '../core/graph.ts';
import {
  abortMerge, commitAll, commitBaseline, detectRepo, directoryFingerprint, ensureWorktree, fastForwardCheckout, git,
  hasHead, initRepo, isClean, mergeRef, pathInside, repoFingerprint, resetHard, revParse, scopedDirty, updateRef, worktreeList,
  checkedOutBranch, projectPathEntries,
} from './git.ts';

interface PreparationFields {
  repoRoot?: string | null | undefined; projectSubdir?: string | null | undefined; branch?: string | null | undefined;
  baselineSha?: string | null | undefined; detail?: Json | null | undefined;
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
    const branch = `graph/task/${taskId}`;
    const integrationPath = join(this.stateDir, 'worktrees', taskId, 'integration');
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

  workspace(taskId: string, instanceId: string | null, nodeId: string, kind: NodeSpec['kind']) {
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
    if (existing) return subdir ? join(existing.path, subdir) : existing.path;
    const branch = `graph/copy/${taskId}/${nodeId}`;
    const path = join(this.stateDir, 'worktrees', taskId, instanceId);
    const start = task.integration_sha ?? revParse(repo, task.integration_branch)!;
    ensureWorktree(repo, path, branch, start);
    this.store.db.prepare('INSERT OR IGNORE INTO worktrees VALUES(?,?,?,?,?)').run(instanceId, taskId, nodeId, path, branch);
    return subdir ? join(path, subdir) : path;
  }

  integrate(operation: Operation) {
    if (!operation.instanceId || operation.kind !== 'agent') return;
    const task = this.store.task(operation.taskId);
    if (!task.integration_branch) return;
    const tree = this.store.db.prepare('SELECT path,branch FROM worktrees WHERE instance_id=?').get(operation.instanceId) as { path: string; branch: string } | undefined;
    const integration = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${operation.taskId}`) as { path: string } | undefined;
    if (!tree || !integration) return;
    const sha = commitAll(tree.path, `graph:${operation.nodeId}:${operation.id}`);
    if (sha) this.store.db.prepare('INSERT INTO git_commits VALUES(?,?,?,?,?)').run(sha, operation.taskId, operation.nodeId, operation.id, 'instance');
    const merged = mergeRef(integration.path, tree.branch);
    if (!merged.ok) return merged;
    let rebases: { path: string; sha: string }[] = [];
    this.store.transaction(() => {
      const previous = this.store.task(operation.taskId).integration_sha;
      this.store.db.prepare('UPDATE tasks SET integration_sha=? WHERE id=?').run(merged.sha, operation.taskId);
      this.store.db.prepare('INSERT INTO git_commits VALUES(?,?,?,?,?)').run(merged.sha, operation.taskId, operation.nodeId, operation.id, 'integration');
      if (previous && previous !== merged.sha) rebases = this.invalidateChecks(operation.taskId);
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
    const moved = mergeRef(integrationPath, targetBranch);
    if (!moved.ok) return { status: 'blocked' as const, data: { kind: 'git_conflict', conflicts: moved.conflicts, reason: 'Target branch changed' } as Json };
    let rebases: { path: string; sha: string }[] = [];
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE tasks SET integration_sha=?,target_sha=? WHERE id=?').run(moved.sha, targetSha, taskId);
      rebases = this.invalidateChecks(taskId);
    });
    for (const rebase of rebases) resetHard(rebase.path, rebase.sha);
    return { status: 'recheck' as const };
  }

  private invalidateChecks(taskId: string) {
    this.store.db.prepare('UPDATE evidence SET valid=0 WHERE task_id=? AND valid=1').run(taskId);
    const graph = loadGraph(this.store, taskId);
    const reset = new Set<string>();
    for (const [id, spec] of graph.plan.nodes) {
      if (spec.kind !== 'program' || graph.status(id) !== 'succeeded') continue;
      reset.add(id);
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
    this.store.event(taskId, 'git.recheck', { reason: 'Integration commit changed' });
    return rebases;
  }
}
