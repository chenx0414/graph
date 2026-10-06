import type { ArtifactWorkspace } from './artifact-workspace.ts';
import { graphAcceptance } from './graph-acceptance.ts';
import { reconcileKernelUsage } from '../runtime/kernel-provider-gate.ts';
import type { TokenUsage } from '../runtime/call-broker.ts';
import { canonicalJson } from './store.ts';
import { randomUUID } from 'node:crypto';
import { GraphRuntime, type PatchChange } from './graph-runtime.ts';
import { ModuleRuntime } from './module-runtime.ts';
import { explainEdge, explainModule } from './kernel-explain.ts';
import { parseGraphDefinition, type GraphDefinition } from './interface-spec.ts';
import type { KernelStore } from './kernel-store.ts';
import { RuntimeError, type Json } from './types.ts';

/** Main-agent management contract. Every target remains in the owner's conversation. */
export interface GraphManagement {
  graphCreate(input: { definition: GraphDefinition; targetBranch?: string; requestId?: string }): Promise<unknown>;
  graphPatch(input: { graphId: string; baseRevision: number; changes: PatchChange }): Promise<unknown>;
  graphInspect(input: { graphId: string; query?: string; id?: string; after?: number; limit?: number }): Promise<unknown>;
  graphControl(input: { graphId: string; action: string; nodeId?: string; moduleId?: string; seq?: number; operationId?: string; callId?: string; usage?: TokenUsage }): Promise<unknown>;
  graphSend(input: { graphId: string; nodeId?: string; input?: string; value?: Json; text?: string }): Promise<unknown>;
}

export function graphManagement(kernel: KernelStore, ownerTaskId: string, prepare?: (graphId: string, branch: string) => void, artifacts?: ArtifactWorkspace): GraphManagement {
  const owner = () => kernel.store.task(ownerTaskId);
  const runtime = (graphId: string) => {
    const target = kernel.store.task(graphId);
    const binding = kernel.db.prepare('SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?').get(graphId) as { owner_task_id: string } | undefined;
    if (graphId !== ownerTaskId && binding?.owner_task_id !== ownerTaskId && (!owner().conversation_id || target.conversation_id !== owner().conversation_id)) {
      throw new RuntimeError('permission', 'Graph belongs to another conversation');
    }
    if (!kernel.latestRevision(graphId)) throw new RuntimeError('invalid_graph', 'Target has no graph definition');
    return new GraphRuntime(kernel, graphId, artifacts);
  };
  return {
    async graphCreate(input) {
      const definition = parseGraphDefinition(input.definition);
      const requestId = input.requestId ?? randomUUID();
      const content = canonicalJson({ definition, targetBranch: input.targetBranch ?? null });
      const previous = kernel.db.prepare('SELECT graph_id,content,state FROM kernel_create_requests WHERE owner_task_id=? AND request_id=?').get(ownerTaskId, requestId) as { graph_id: string; content: string; state: string } | undefined;
      if (previous && previous.content !== content) throw new RuntimeError('invalid_input', 'Creation requestId was already used with a different definition');
      const graphId = previous?.graph_id ?? randomUUID();
      const parent = owner();
      const created = previous ? { graphId, definition: kernel.latestRevision(graphId)!.definition, revision: kernel.latestRevision(graphId)!.version } : kernel.store.transaction(() => {
        kernel.db.prepare('INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase,target_branch) VALUES(?,?,?,?,1,0,?,?,?)')
          .run(graphId, parent.project_id, parent.conversation_id, definition.name, Date.now(), 'running', input.targetBranch ?? null);
        if (input.targetBranch) kernel.db.prepare('UPDATE tasks SET paused=1 WHERE id=?').run(graphId);
        kernel.db.prepare('INSERT INTO kernel_create_requests(owner_task_id,request_id,graph_id,content,state) VALUES(?,?,?,?,?)').run(ownerTaskId, requestId, graphId, content, input.targetBranch ? 'preparing' : 'ready');
        kernel.db.prepare('INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)').run(graphId, ownerTaskId);
        const revision = kernel.insertRevision(graphId, definition, 'create');
        for (const id of Object.keys(definition.nodes)) kernel.admitNode(graphId, revision.version, id, { instanceId: randomUUID() });
        for (const [id, module] of Object.entries(definition.modules)) kernel.admitModule(graphId, revision.version, id, { moduleType: module.type, trigger: module.trigger });
        kernel.store.event(graphId, 'graph.created', { ownerTaskId, revision: revision.version });
        return { graphId, definition, revision: revision.version };
      });
      if (input.targetBranch && previous?.state !== 'ready') {
        try {
          if (!prepare) throw new RuntimeError('invalid_input', 'Git preparation is unavailable');
          prepare(graphId, input.targetBranch);
          kernel.store.transaction(() => {
            kernel.db.prepare("UPDATE kernel_create_requests SET state='ready',error=NULL WHERE owner_task_id=? AND request_id=?").run(ownerTaskId, requestId);
            kernel.db.prepare("UPDATE tasks SET paused=0,phase='running' WHERE id=?").run(graphId);
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          kernel.store.transaction(() => {
            kernel.db.prepare("UPDATE kernel_create_requests SET state='failed',error=? WHERE owner_task_id=? AND request_id=?").run(reason, ownerTaskId, requestId);
            kernel.db.prepare("UPDATE tasks SET paused=1,phase='blocked' WHERE id=?").run(graphId);
            kernel.store.event(graphId, 'graph.preparation.failed', { reason, requestId });
          });
          return { ...created, requestId, state: 'blocked', reason };
        }
      }
      return { ...created, requestId, replayed: Boolean(previous) };
    },
    async graphPatch(input) { return runtime(input.graphId).patch(input); },
    async graphInspect(input) {
      const graph = runtime(input.graphId);
      const historyQuery = { ...(input.id ? { nodeId: input.id } : {}), ...(input.after === undefined ? {} : { after: input.after }), ...(input.limit === undefined ? {} : { limit: input.limit }) };
      if (input.query === 'queue') return kernel.queueHistory(input.graphId, historyQuery);
      if (input.query === 'executions') return kernel.executionHistory(input.graphId, historyQuery);
      if (input.query === 'acceptance') return graphAcceptance(kernel, input.graphId, artifacts);
      if (input.query === 'provider_calls') return kernel.providerCalls(input.graphId, input.id);
      if (input.query === 'operations') return (kernel.db.prepare('SELECT id,module_id,delivery_id,revision_version,request,state,result,error,created_at,started_at,ended_at FROM kernel_module_operations WHERE task_id=? ORDER BY created_at').all(input.graphId) as { request: string; result: string | null }[]).map(row => ({ ...row, request: JSON.parse(row.request), result: row.result ? JSON.parse(row.result) : null }));
      if (input.query === 'edge') return explainEdge(kernel, input.graphId, input.id!);
      if (input.query === 'module') return explainModule(kernel, input.graphId, input.id!);
      if (input.query === 'results') return (kernel.db.prepare('SELECT * FROM kernel_graph_results WHERE task_id=? ORDER BY rowid').all(input.graphId) as { value: string }[]).map(row => ({ ...row, value: JSON.parse(row.value) }));
      if (input.query && !['summary', 'revision', 'nodes'].includes(input.query)) throw new RuntimeError('invalid_query', `Unknown graph query ${input.query}`);
      return graph.inspect({ kind: input.query === 'revision' ? 'revision' : input.query === 'nodes' ? 'nodes' : 'summary' });
    },
    async graphControl(input) {
      const graph = runtime(input.graphId);
      if (['pause', 'resume', 'reopen', 'retry', 'skip', 'cancel'].includes(input.action)
        && ['completed', 'stopping', 'stopped'].includes(graph.state()!.phase)) {
        throw new RuntimeError('invalid_graph', 'Ended graph cannot change its execution controls');
      }
      if (input.action === 'cancel_operation') {
        const operation = kernel.db.prepare('SELECT delivery_id,module_id,state FROM kernel_module_operations WHERE task_id=? AND id=?').get(input.graphId, input.operationId ?? '') as { delivery_id: string; module_id: string; state: string } | undefined;
        if (!operation || !['uncertain', 'failed', 'cancelled'].includes(operation.state)) throw new RuntimeError('invalid_operation', 'Only an interrupted or failed operation can be cancelled; stop active work first');
        if (operation.state === 'cancelled') return graph.state();
        kernel.moduleTransaction(() => {
          kernel.db.prepare("UPDATE kernel_module_operations SET state='cancelled' WHERE id=?").run(input.operationId!);
          kernel.db.prepare('UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?').run(operation.delivery_id);
          kernel.setNodeQueuePaused(input.graphId, operation.module_id, false);
          kernel.db.prepare("UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked' AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)").run(input.graphId, input.graphId);
          kernel.store.event(input.graphId, 'graph.operation.cancelled', { operationId: input.operationId!, deliveryId: operation.delivery_id, moduleId: operation.module_id });
        });
        return graph.state();
      }
      if (input.action === 'reconcile_usage') {
        if (!input.callId || !input.usage) throw new RuntimeError('invalid_input', 'reconcile_usage requires callId and usage');
        return reconcileKernelUsage(kernel, input.graphId, input.callId, input.usage);
      }
      if (input.action === 'complete') return graph.complete();
      if (input.action === 'withdraw_complete') return graph.withdrawComplete();
      if (input.action === 'stop') return graph.stop();
      if (input.action === 'reopen') {
        if (!input.moduleId) throw new RuntimeError('invalid_input', 'reopen requires moduleId');
        return new ModuleRuntime(kernel, input.graphId, kernel.latestRevision(input.graphId)!.version).reopenAfterPending(input.moduleId);
      }
      if (input.action === 'pause' || input.action === 'resume') {
        if (input.nodeId) {
          kernel.setNodeQueuePaused(input.graphId, input.nodeId, input.action === 'pause');
          if (input.action === 'resume') kernel.db.prepare("UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'").run(input.graphId, input.nodeId);
        }
        else kernel.db.prepare('UPDATE tasks SET paused=? WHERE id=?').run(input.action === 'pause' ? 1 : 0, input.graphId);
        return graph.state();
      }
      if (['retry', 'skip', 'cancel'].includes(input.action)) {
        if (input.seq === undefined) throw new RuntimeError('invalid_input', `${input.action} requires queue seq`);
        const seq = input.seq;
        const row = kernel.db.prepare('SELECT node_id,state FROM kernel_queue WHERE task_id=? AND seq=?').get(input.graphId, seq) as { node_id: string; state: string } | undefined;
        if (!row || row.state === 'claimed') throw new RuntimeError('invalid_queue', 'Queue item is absent or still executing');
        const submitted = kernel.db.prepare('SELECT submission_id FROM kernel_executions WHERE task_id=? AND node_id=? AND submission_id IS NOT NULL AND (id=? OR id GLOB ?)').get(input.graphId, row.node_id, `exec-${input.graphId}-${row.node_id}-${input.seq}`, `exec-${input.graphId}-${row.node_id}-${input.seq}-[0-9]*`);
        if (input.action === 'retry' && submitted) throw new RuntimeError('invalid_queue', 'Submitted work cannot be sent again');
        kernel.store.transaction(() => {
          kernel.db.prepare('UPDATE kernel_queue SET state=?,reason=?,generation=generation+? WHERE task_id=? AND seq=?')
            .run(input.action === 'retry' ? 'queued' : 'done', input.action, input.action === 'retry' ? 1 : 0, input.graphId, seq);
          kernel.db.prepare('UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?').run(input.graphId, row.node_id);
          kernel.db.prepare("UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status IN ('blocked','failed')").run(input.graphId, row.node_id);
          kernel.db.prepare("UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked' AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)").run(input.graphId, input.graphId);
          kernel.store.event(input.graphId, `graph.queue.${input.action}`, { seq: input.seq, nodeId: row.node_id });
        });
        return graph.state();
      }
      throw new RuntimeError('invalid_input', `Unknown graph control action ${input.action}`);
    },
    async graphSend(input) {
      const graph = runtime(input.graphId);
      if (input.input !== undefined) {
        const endpoint = input.nodeId ? `${input.nodeId}.${input.input}` : kernel.latestRevision(input.graphId)!.definition.inputs[input.input]?.to;
        if (!endpoint) throw new RuntimeError('invalid_input', `Unknown public input ${input.input}`);
        return graph.deliverEndpoint(endpoint, input.value ?? null);
      }
      if (!input.nodeId) throw new RuntimeError('invalid_input', 'Chat requires nodeId');
      return graph.chat({ nodeId: input.nodeId, text: input.text ?? '' });
    },
  };
}
