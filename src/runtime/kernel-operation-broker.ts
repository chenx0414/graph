import { waitForKernelProgramExecutionSlot } from './execution-slots.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../core/store.ts';
import type { KernelStore } from '../core/kernel-store.ts';
import type { ModuleDefinition } from '../core/interface-spec.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { git, revParse } from '../git/git.ts';
import { openWorkspaceCommandRunner, resolveUnsandboxedCommand } from './workspace-command.ts';
import { checkEnvironment, runHostCommand } from './host-command.ts';

/** Host operations keep a durable send boundary; replaying a result never re-runs its command. */
export async function executeModuleOperation(options: {
  kernel: KernelStore; graphId: string; moduleId: string; deliveryId: string; revisionVersion: number;
  operation: NonNullable<ModuleDefinition['operation']>; workspace: string; scratchRoot: string;
  state: Json; inputs: Record<string, Json>; access?: ResolvedAccessPolicy; signal?: AbortSignal;
}): Promise<{ ok: boolean; state: Json; outputs: Record<string, Json>; diagnostics: string[] }> {
  const { kernel, graphId, moduleId, deliveryId, operation, workspace } = options;
  const previous = kernel.db.prepare('SELECT id,state,result FROM kernel_module_operations WHERE delivery_id=?').get(deliveryId) as
    { id: string; state: string; result: string | null } | undefined;
  if (previous?.state === 'settled') return JSON.parse(previous.result!);
  if (previous?.state === 'cancelled') throw new RuntimeError('invalid_operation', 'Cancelled operation input cannot be replayed; send a new input explicitly');
  if (previous && ['dispatched', 'uncertain'].includes(previous.state)) throw new RuntimeError('uncertain_operation', `Operation ${previous.id} may have side effects; reconcile or cancel it before retrying`);
  if (operation.sandbox === false && options.access?.mode !== 'full') throw new RuntimeError('permission', 'workspace.command sandbox:false requires full access');
  const id = previous?.id ?? randomUUID();
  const created = Date.now();
  const request = canonicalJson({ operation, inputs: options.inputs, workspace });
  kernel.db.prepare(`INSERT INTO kernel_module_operations(id,task_id,module_id,delivery_id,revision_version,request,state,created_at)
    VALUES(?,?,?,?,?,?,'prepared',?) ON CONFLICT(delivery_id) DO UPDATE SET request=excluded.request,revision_version=excluded.revision_version,state='prepared',error=NULL,resource_receipt=NULL,record_digest=NULL`)
    .run(id, graphId, moduleId, deliveryId, options.revisionVersion, request, created);
  let commit: string | null = null;
  let cleanBefore = false;
  const cleanTree = () => { const status = git(workspace, ['status', '--porcelain', '-u']); return status.code === 0 && status.stdout.trim() === ''; };
  const admit = () => {
    const task = kernel.store.task(graphId);
    if (task.paused || options.signal?.aborted || ['stopping', 'stopped', 'completed'].includes(task.phase)) throw new RuntimeError('paused', 'Graph operation dispatch is closed');
    if (kernel.nodeState(graphId, moduleId).paused) throw new RuntimeError('paused', 'Module is paused');
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
    let result;
    if (operation.sandbox === false) {
      const command = resolveUnsandboxedCommand(operation.command, operation.args);
      const nonce = randomUUID();
      const quiescence = { path: join(scratchDir, `quiescence-${nonce}.json`), nonce };
      kernel.db.prepare('UPDATE kernel_module_operations SET resource_receipt=? WHERE id=?').run(canonicalJson(quiescence), id);
      const running = runHostCommand({ cwd: workspace, executable: command.executable, args: command.args,
        env: checkEnvironment({ executable: command.executable, host: process.env, ...(command.env ? { declared: command.env } : {}) }),
        timeoutMs: operation.timeoutMs ?? 120_000, signal: cancellation.signal, quiescence,
        beforeStart: () => { admit(); dispatched(); } });
      result = await running;
    } else {
      runner = await openWorkspaceCommandRunner({ workspace, scratchDir,
        // Sandboxed checks share authority, not temporary files, even under full access.
        env: { TMPDIR: await realpath(scratchDir) },
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
    kernel.db.prepare("UPDATE kernel_module_operations SET state='settled',result=?,record_digest=?,ended_at=? WHERE id=?").run(canonicalJson(evaluated), recordDigest, Date.now(), id);
    kernel.store.event(graphId, 'graph.operation.settled', { moduleId, operationId: id, passed: output.passed, commit, verifiedCommit, record: recordPath });
    return evaluated;
  } catch (error) {
    cancellation.abort();
    const reason = error instanceof Error ? error.message : String(error);
    kernel.db.prepare("UPDATE kernel_module_operations SET state=CASE WHEN state='dispatched' THEN 'uncertain' ELSE 'failed' END,error=?,ended_at=? WHERE id=? AND state!='settled'").run(reason, Date.now(), id);
    throw error;
  } finally {
    unsubscribe(); options.signal?.removeEventListener('abort', abort);
    try { await runner?.close(); }
    finally { kernel.db.prepare('UPDATE kernel_module_operations SET worker_active=0 WHERE id=?').run(id); }
  }
}
