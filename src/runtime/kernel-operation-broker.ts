import { waitForKernelProgramExecutionSlot } from './execution-slots.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../core/store.ts';
import type { KernelStore } from '../core/kernel-store.ts';
import type { ModuleDefinition } from '../core/interface-spec.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { git, revParse } from '../git/git.ts';
import { openWorkspaceCommandRunner, resolveUnsandboxedCommand } from './workspace-command.ts';
import { checkEnvironment, runHostCommand } from './host-command.ts';
import { linkProjectDependencies } from './project-dependencies.ts';

/**
 * A `workspace.command` operation reads code out of the integration worktree, so it may only be
 * admitted once the delivery's causal commit is really in that tree. An execution being `completed`
 * is not that fact: a source that submitted and then failed to merge has an output but no
 * integration, and a source that is still running has not merged yet.
 *
 * Only this action is gated, and only in the integration copy: agents, ordinary modules, `each`
 * routers, immediate delivery and graphs without Git keep their own timing. Nothing is inferred
 * into the protocol value — the delivery keeps exactly the value its producer emitted, and the
 * operation's own receipt still names the commit it read.
 */
function admitSource(options: { kernel: KernelStore; graphId: string; deliveryId: string; workspace: string; operation: NonNullable<ModuleDefinition['operation']>; integratesSource?: (executionId: string) => boolean }): void {
  const { kernel, graphId, deliveryId, workspace, operation } = options;
  if (operation.action !== 'workspace.command') return;
  if (!kernel.store.task(graphId).integration_branch) return;
  const integration = kernel.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graphId}`) as { path: string } | undefined;
  if (!integration || resolve(integration.path) !== resolve(workspace)) return;
  const source = kernel.db.prepare(`SELECT s.execution_id AS execution,e.state AS state FROM kernel_deliveries d
    LEFT JOIN kernel_submissions s ON s.id=d.submission_id LEFT JOIN kernel_executions e ON e.id=s.execution_id
    WHERE d.id=?`).get(deliveryId) as { execution: string | null; state: string | null } | undefined;
  // Main-delivered and module-to-module input has no causal producer to wait for.
  if (!source?.execution) return;
  // Whether this source owes the integration branch a commit is a production fact (its frozen recipe,
  // its admitted work location), not the absence of a commit row — a node may submit first and be
  // committed automatically at settle. The host answers it; a commit row cannot.
  const integrates = options.integratesSource
    ? options.integratesSource(source.execution)
    : Boolean(kernel.db.prepare("SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='instance'").get(graphId, source.execution));
  if (!integrates) return;
  const merged = kernel.db.prepare("SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='integration'").get(graphId, source.execution) as { sha: string } | undefined;
  if (!merged) {
    // A short wait, not a repair: the delivery stays pending and the same one is retried.
    if (source.state === 'running') throw new RuntimeError('paused', `Delivery source ${source.execution} has not been integrated yet`);
    throw new RuntimeError('integration_blocked', `Delivery source ${source.execution} did not reach the integration branch`);
  }
  const produced = kernel.db.prepare("SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='instance'").get(graphId, source.execution) as { sha: string } | undefined;
  if (produced && git(workspace, ['merge-base', '--is-ancestor', produced.sha, 'HEAD']).code !== 0) {
    throw new RuntimeError('integration_blocked', `Delivery source ${source.execution} produced ${produced.sha}, which the integration worktree does not contain`);
  }
}

/** Host operations keep a durable send boundary; replaying a result never re-runs its command. */
export async function executeModuleOperation(options: {
  kernel: KernelStore; graphId: string; moduleId: string; deliveryId: string; revisionVersion: number;
  operation: NonNullable<ModuleDefinition['operation']>; workspace: string; scratchRoot: string;
  integratesSource?: (executionId: string) => boolean;
  state: Json; inputs: Record<string, Json>; access?: ResolvedAccessPolicy; signal?: AbortSignal;
  program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string };
}): Promise<{ ok: boolean; state: Json; outputs: Record<string, Json>; diagnostics: string[] }> {
  const { kernel, graphId, moduleId, deliveryId, operation, workspace } = options;
  const previous = kernel.db.prepare('SELECT id,state,result FROM kernel_module_operations WHERE delivery_id=?').get(deliveryId) as
    { id: string; state: string; result: string | null } | undefined;
  if (previous?.state === 'settled') return kernel.content.decode(previous.result!);
  if (previous?.state === 'cancelled') throw new RuntimeError('invalid_operation', 'Cancelled operation input cannot be replayed; send a new input explicitly');
  if (previous && ['dispatched', 'uncertain'].includes(previous.state)) throw new RuntimeError('uncertain_operation', `Operation ${previous.id} may have side effects; reconcile or cancel it before retrying`);
  if (operation.sandbox === false && options.access?.mode !== 'full') throw new RuntimeError('permission', 'workspace.command sandbox:false requires full access');
  const id = previous?.id ?? randomUUID();
  const created = Date.now();
  kernel.store.transaction(() => {
    const request = kernel.content.encode({ operation, inputs: options.inputs, workspace });
    kernel.db.prepare(`INSERT INTO kernel_module_operations(id,task_id,module_id,delivery_id,revision_version,request,state,created_at)
    VALUES(?,?,?,?,?,?,'prepared',?) ON CONFLICT(delivery_id) DO UPDATE SET request=excluded.request,revision_version=excluded.revision_version,state='prepared',error=NULL,resource_receipt=NULL,record_digest=NULL`)
    .run(id, graphId, moduleId, deliveryId, options.revisionVersion, request, created);
  });
  let commit: string | null = null;
  let cleanBefore = false;
  const cleanTree = () => { const status = git(workspace, ['status', '--porcelain', '-u']); return status.code === 0 && status.stdout.trim() === ''; };
  const admit = () => {
    const task = kernel.store.task(graphId);
    if (task.paused || options.signal?.aborted || ['stopping', 'stopped', 'completed'].includes(task.phase)) throw new RuntimeError('paused', 'Graph operation dispatch is closed');
    if (kernel.nodeState(graphId, moduleId).paused) throw new RuntimeError('paused', 'Module is paused');
    admitSource({ kernel, graphId, deliveryId, workspace, operation, ...(options.integratesSource ? { integratesSource: options.integratesSource } : {}) });
    commit = revParse(workspace, 'HEAD') ?? null;
    cleanBefore = commit !== null && cleanTree();
    const changed = kernel.db.prepare("UPDATE kernel_module_operations SET state='dispatched',started_at=? WHERE id=? AND state='prepared'").run(Date.now(), id);
    if (changed.changes !== 1) throw new RuntimeError('invalid_operation', 'Operation is no longer dispatchable');
  };
  const scratchDir = join(options.scratchRoot, 'module-operations', id);
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = kernel.store.onEvent(() => { if (['stopping', 'stopped'].includes(kernel.store.task(graphId).phase)) abort(); });
  const dispatched = () => kernel.store.event(graphId, 'graph.operation.dispatched', { moduleId, operationId: id, deliveryId });
  let runner: Awaited<ReturnType<typeof openWorkspaceCommandRunner>> | undefined;
  try {
    await waitForKernelProgramExecutionSlot(kernel.store, id, cancellation.signal);
    const modules = await linkProjectDependencies(workspace, options.program?.nodeModulesPath);
    const readPaths = (await Promise.all([...(options.program?.readPaths ?? []), ...(modules ? [modules] : [])]
      .map(path => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined);
    let result;
    if (operation.sandbox === false) {
      const command = resolveUnsandboxedCommand(operation.command, operation.args);
      const nonce = randomUUID();
      const quiescence = { path: join(scratchDir, `quiescence-${nonce}.json`), nonce };
      kernel.db.prepare('UPDATE kernel_module_operations SET resource_receipt=? WHERE id=?').run(canonicalJson(quiescence), id);
      const running = runHostCommand({ cwd: workspace, executable: command.executable, args: command.args,
        env: checkEnvironment({ executable: command.executable, host: process.env, declared: { ...options.program?.env, ...command.env } }),
        timeoutMs: operation.timeoutMs ?? 120_000, signal: cancellation.signal, quiescence,
        beforeStart: () => { admit(); dispatched(); } });
      result = await running;
    } else {
      runner = await openWorkspaceCommandRunner({ workspace, scratchDir,
        // Sandboxed checks share authority, not temporary files, even under full access.
        env: { ...options.program?.env, TMPDIR: options.program?.env?.TMPDIR ?? await realpath(scratchDir) },
        readPaths, localNetwork: true, gitMetadataWritesInsideScratch: true,
        gate: { dispatch: (_id, _reservation, send) => { admit(); const started = send(); dispatched(); return started; }, settle: () => {} },
        ...(options.access ? { access: options.access } : {}), timeoutMs: operation.timeoutMs ?? 120_000 });
      result = await runner.run(operation.command, operation.args, cancellation.signal);
    }
    if (cancellation.signal.aborted) throw new RuntimeError('uncertain_operation', 'Operation interrupted after dispatch; inspect its side effects before continuing');
    const commitAfter = revParse(workspace, 'HEAD') ?? null;
    const cleanAfter = commitAfter !== null && cleanTree();
    const verifiedCommit = result.code === 0 && commit && commit === commitAfter && cleanBefore && cleanAfter ? commit : null;
    const record = { operationId: id, command: operation.command, args: operation.args, ...result, commit, commitAfter, cleanBefore, cleanAfter, verifiedCommit,
      sandboxed: operation.sandbox !== false, elapsedMs: Date.now() - created };
    const recordPath = join(scratchDir, 'result.json');
    const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(recordPath, recordBytes, { mode: 0o600 });
    const recordDigest = createHash('sha256').update(recordBytes).digest('hex');
    const output = { passed: result.code === 0, code: result.code, commit, verifiedCommit, record: recordPath, operationId: id,
      stdout: result.stdout.slice(-32_768), stderr: result.stderr.slice(-32_768), elapsedMs: record.elapsedMs };
    const evaluated = { ok: true, state: options.state, outputs: { [operation.output]: output }, diagnostics: [`workspace.command ${id}`] };
    kernel.store.transaction(() => {
      kernel.db.prepare("UPDATE kernel_module_operations SET state='settled',result=?,record_digest=?,ended_at=? WHERE id=?").run(kernel.content.encode(evaluated), recordDigest, Date.now(), id);
    });
    kernel.store.event(graphId, 'graph.operation.settled', { moduleId, operationId: id, passed: output.passed, commit, verifiedCommit, record: recordPath });
    return evaluated;
  } catch (error) {
    cancellation.abort();
    const reason = error instanceof Error ? error.message : String(error);
    const unsentPause = error instanceof RuntimeError && error.code === 'paused'
      && kernel.db.prepare("SELECT 1 FROM kernel_module_operations WHERE id=? AND state='prepared'").get(id);
    if (unsentPause) throw error;
    kernel.db.prepare("UPDATE kernel_module_operations SET state=CASE WHEN state='dispatched' THEN 'uncertain' ELSE 'failed' END,error=?,ended_at=? WHERE id=? AND state!='settled'").run(reason, Date.now(), id);
    throw error;
  } finally {
    unsubscribe(); options.signal?.removeEventListener('abort', abort);
    try { await runner?.close(); }
    finally { kernel.db.prepare('UPDATE kernel_module_operations SET worker_active=0 WHERE id=?').run(id); }
  }
}
