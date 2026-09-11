import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json, type NodeSpec, type Operation } from '../core/types.ts';
import { createActivation, loadGraph } from '../core/graph.ts';
import {
  abortMerge, checkedOutBranch, commitAll, detectRepo, ensureWorktree, fastForwardCheckout,
  isClean, mergeRef, pathInside, resetHard, revParse, updateRef,
} from './git.ts';

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
    if (this.repos.has(task.project_id)) return this.repos.get(task.project_id);
    const project = this.store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string };
    const root = detectRepo(project.root);
    this.repos.set(task.project_id, root);
    return root;
  }

  prepareTask(taskId: string, targetBranch: string) {
    const repo = this.repoRoot(taskId);
    if (!repo) return;
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
    if (kind !== 'agent' || !instanceId) {
      const row = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${taskId}`) as { path: string } | undefined;
      return row?.path;
    }
    const existing = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(instanceId) as { path: string } | undefined;
    if (existing) return existing.path;
    const branch = `graph/copy/${taskId}/${nodeId}`;
    const path = join(this.stateDir, 'worktrees', taskId, instanceId);
    const start = task.integration_sha ?? revParse(repo, task.integration_branch)!;
    ensureWorktree(repo, path, branch, start);
    this.store.db.prepare('INSERT OR IGNORE INTO worktrees VALUES(?,?,?,?,?)').run(instanceId, taskId, nodeId, path, branch);
    return path;
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
    const checkout = checkedOutBranch(repo);
    if (checkout === task.target_branch) {
      const ignore = pathInside(repo, this.stateDir) ? [this.stateDir] : [];
      if (!isClean(repo, ignore)) {
        this.store.db.prepare("UPDATE git_ops SET state='blocked',result=? WHERE id=?").run(canonicalJson({ kind: 'git_dirty' }), opId);
        return { status: 'blocked', data: { kind: 'git_dirty', reason: 'Target worktree is dirty' } };
      }
      const forwarded = fastForwardCheckout(repo, integrationSha);
      if (!forwarded.ok) {
        this.store.db.prepare("UPDATE git_ops SET state='failed',result=? WHERE id=?").run(canonicalJson({ stderr: forwarded.stderr }), opId);
        return this.recheckAgainstTarget(taskId, integration.path, task.target_branch, revParse(repo, task.target_branch) ?? targetSha);
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
      const node = this.store.db.prepare('SELECT instance_id,activation_id,status FROM nodes WHERE task_id=? AND id=?').get(taskId, id) as { instance_id: string | null; activation_id: string; status: string };
      if (['preparing', 'running'].includes(node.status)) continue;
      this.store.db.prepare("UPDATE activations SET state='invalidated' WHERE id=?").run(node.activation_id);
      createActivation(this.store, taskId, id, task.graph_version);
      this.store.db.prepare("UPDATE nodes SET status='pending',output=NULL,output_operation=NULL,route=NULL WHERE task_id=? AND id=?").run(taskId, id);
      if (node.instance_id && task.integration_sha) {
        const tree = this.store.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(node.instance_id) as { path: string } | undefined;
        if (tree) rebases.push({ path: tree.path, sha: task.integration_sha });
      }
    }
    this.store.event(taskId, 'git.recheck', { reason: 'Integration commit changed' });
    return rebases;
  }
}
