import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, configure, createRegistry, defineDoc, type AgentChange, type ConversationId, type Cursor, type Tx, type ToolRegistration } from '@earendil-works/pi-durable';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { openDurableStorage } from './durable-storage.ts';
import { freezeDurableModel, restoreDurableResources, type freezeDurableResources } from './durable-freeze.ts';
import { installDurableModel } from './durable-models.ts';
import { defineExtension } from '@earendil-works/pi-durable';
import type { AgentSessionRequest } from './agent-session.ts';
import type { TaskStore } from '../core/store.ts';

const Identities = defineDoc<{ conversations: Record<string, number> }>({ kind: 'graph.identities', scope: 'session', version: 1, initial: () => ({ conversations: {} }) });
export type FrozenDurableExecution = {
  identity: string;
  executionId: string;
  inputRequestId: string;
  originalInputRequestId?: string;
  preAdmissionInvocationIds?: string[];
  model: AgentSessionRequest['model'];
  agent: AgentChange;
  extensionName: string;
  tools: Pick<ToolRegistration, 'name' | 'description' | 'parameters'>[];
  configuration: Awaited<ReturnType<typeof freezeDurableResources>>;
};
const Executions = defineDoc<{ conversations: Record<string, string> }>({ kind: 'graph.frozen-executions', scope: 'session', version: 1, initial: () => ({ conversations: {} }) });
/** One Harness and one off-thread storage owner for main and every Graph node.
 * Identity creation and mapping commit together, leaving no orphan-ack window. */
export async function openDurableHost(store: TaskStore, models: MutableModels) {
  const registry = createRegistry();
  const storage = await openDurableStorage(store);
  try {
    const harness = await Harness.open(storage, { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1024, backgroundTokens: 0 } } }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT);
    // No operation below this barrier enables the global scheduler. Rebind
    // every interrupted admission first, including conversations not selected
    // by the user. Unknown Graph dispatches cannot issue another provider call.
    type ReadyAdmission = { request: AgentSessionRequest; instructions: string; configuration: FrozenDurableExecution['configuration']; close?: () => Promise<void> };
    const hasKernelTables = Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_executions'").get());
    const admissions = new Map<string, ReadyAdmission>();
    let notifyAdmission: (() => void) | undefined;
    let loader: ((snapshot: FrozenDurableExecution) => Promise<ReadyAdmission | undefined>) | undefined;
    const interrupted = new Set<number>();
    const restoredInputs = new Set<string>();
    let recovered: Promise<void> | undefined;
    const recover = (ready?: ReadyAdmission) => {
      if (ready?.request.executionId) { admissions.set(ready.request.executionId, ready); notifyAdmission?.(); }
      const registered = recovered ??= (async () => {
    const frozen = await root.commit(async tx => JSON.parse(JSON.stringify((await tx.doc(Executions)).conversations)) as Record<string, string>, BACKGROUND_CONTEXT);
    // Steering inputs belong to the same frozen Graph execution. Read their
    // actual SDK receipts, including a completed answer whose Graph ACK died.
    for (const [id, encoded] of Object.entries(frozen)) {
      const snapshot: FrozenDurableExecution = JSON.parse(encoded);
      const original = snapshot.originalInputRequestId ?? snapshot.inputRequestId;
      if (!original) continue;
      let cursor: Cursor | undefined;
      let latest: string | undefined;
      do {
        const page = await storage.scanSubmissions({ conversationId: Number(id) as ConversationId, order: 'descending' }, 100, cursor, BACKGROUND_CONTEXT);
        latest = page.items.find(item => item.type === 'input' && typeof item.requestId === 'string' && item.requestId.startsWith(original + ':continuation:'))?.requestId;
        cursor = page.next;
      } while (!latest && cursor);
      if (latest) frozen[id] = JSON.stringify({ ...snapshot, originalInputRequestId: original, inputRequestId: latest });
    }
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    const active = new Set(inspection.tasks.map(task => String(task.record.conversationId)));
    for (const [id, encoded] of Object.entries(frozen)) {
      const snapshot: FrozenDurableExecution = JSON.parse(encoded);
      const operation = store.db.prepare("SELECT 1 FROM operations WHERE id=? AND state IN ('intent','dispatched','unknown')").get(snapshot.executionId);
      const node = hasKernelTables && store.db.prepare("SELECT 1 FROM kernel_executions WHERE id=? AND (state IN ('running','blocked') OR (state='failed' AND submission_id IS NOT NULL))").get(snapshot.executionId);
      if (!operation && !node) continue;
      const receipt = await root.commit(tx => tx.submissionByRequest(Number(id) as ConversationId, snapshot.inputRequestId), BACKGROUND_CONTEXT);
      if (receipt?.status === 'done') active.add(id);
    }
    // Validate every archive before restoring any capability: restoration can
    // record host discovery invocations even while scheduling stays paused.
    // A later missing archive must not leave a partially restored admission.
    for (const id of active) {
      const encoded = frozen[id];
      if (!encoded) throw new Error(`Durable recovery is parked: frozen execution missing for conversation ${id}`);
      const snapshot: FrozenDurableExecution = JSON.parse(encoded);
      const receipt = await root.commit(tx => tx.submissionByRequest(Number(id) as ConversationId, snapshot.inputRequestId), BACKGROUND_CONTEXT);
      if (receipt?.status === 'done') continue;
      const operation = store.db.prepare('SELECT state FROM operations WHERE id=?').get(snapshot.executionId) as { state: string } | undefined;
      const node = hasKernelTables && store.db.prepare('SELECT 1 FROM kernel_executions WHERE id=?').get(snapshot.executionId);
      const mainCall = operation && (store.db.prepare('SELECT id FROM invocations WHERE operation_id=?').all(snapshot.executionId) as { id: string }[]).some(call => !snapshot.preAdmissionInvocationIds?.includes(call.id));
      const nodeCall = node && store.db.prepare('SELECT 1 FROM kernel_provider_calls WHERE execution_id=? LIMIT 1').get(snapshot.executionId);
      const unsafeTool = inspection.tasks.some(task => String(task.record.conversationId) === id && task.record.kind === 'pi.tool' && typeof task.record.state.checkpoint === 'object' && task.record.state.checkpoint !== null && 'phase' in task.record.state.checkpoint && task.record.state.checkpoint.phase === 'execute');
      if ((operation?.state === 'unknown' && (mainCall || unsafeTool)) || (node && (nodeCall || unsafeTool))) continue;
      await restoreDurableResources(snapshot.configuration);
    }
    for (const id of active) {
      const encoded = frozen[id];
      if (!encoded) throw new Error(`Durable recovery is parked: frozen execution missing for conversation ${id}`);
      const snapshot: FrozenDurableExecution = JSON.parse(encoded);
      const operation = store.db.prepare('SELECT state FROM operations WHERE id=?').get(snapshot.executionId) as { state: string } | undefined;
      const nodeExecution = hasKernelTables ? store.db.prepare('SELECT task_id,node_id,state FROM kernel_executions WHERE id=?').get(snapshot.executionId) as { task_id: string; node_id: string; state: string } | undefined : undefined;
      const nodeCall = nodeExecution && store.db.prepare('SELECT 1 FROM kernel_provider_calls WHERE execution_id=? LIMIT 1').get(snapshot.executionId);
      const unsafeTool = inspection.tasks.some(task => String(task.record.conversationId) === id && task.record.kind === 'pi.tool' && typeof task.record.state.checkpoint === 'object' && task.record.state.checkpoint !== null && 'phase' in task.record.state.checkpoint && task.record.state.checkpoint.phase === 'execute');
      const mainCall = operation && (store.db.prepare('SELECT id FROM invocations WHERE operation_id=?').all(snapshot.executionId) as { id: string }[]).some(call => !snapshot.preAdmissionInvocationIds?.includes(call.id));
      const receipt = await root.commit(tx => tx.submissionByRequest(Number(id) as ConversationId, snapshot.inputRequestId), BACKGROUND_CONTEXT);
      const uncertain = receipt?.status !== 'done' && (!!(operation?.state === 'unknown' && (mainCall || unsafeTool)) || !!(nodeExecution && (nodeCall || unsafeTool)));
      if (nodeExecution && nodeExecution.state === 'running') {
        // Project a verified SDK admission into Graph's explicit resume UI.
        // Keep its original input, execution, attempt and budget hold attached;
        // this is domain reattachment, never an Agent checkpoint retry.
        store.transaction(() => {
          const execution = store.db.prepare('SELECT submission_id FROM kernel_executions WHERE id=?').get(snapshot.executionId) as { submission_id: string | null };
          const submitted = Boolean(execution.submission_id);
          store.db.prepare("UPDATE kernel_executions SET state=?,waiting_slot=0,run_ms=NULL,waiting_ms=NULL,run_since=NULL,waiting_since=NULL WHERE id=?")
            .run(submitted ? 'failed' : 'blocked', snapshot.executionId);
          store.db.prepare("UPDATE kernel_queue SET state=?,reason='Original durable input retained for explicit resume' WHERE task_id=? AND node_id=? AND state='claimed'")
            .run(submitted ? 'failed' : 'queued', nodeExecution.task_id, nodeExecution.node_id);
          store.db.prepare('UPDATE kernel_node_state SET paused=1 WHERE task_id=? AND node_id=?').run(nodeExecution.task_id, nodeExecution.node_id);
          store.db.prepare("UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?").run(nodeExecution.task_id, nodeExecution.node_id);
          store.db.prepare("UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')").run(nodeExecution.task_id);
          store.event(nodeExecution.task_id, 'graph.execution.reattached', { executionId: snapshot.executionId, nodeId: nodeExecution.node_id, uncertain });
        });
      }

      if (!uncertain) {
        if (nodeExecution) restoredInputs.add(snapshot.executionId);
        if (snapshot.configuration.incomplete.length) throw new Error(`Durable recovery is parked: original resource closure is incomplete for ${snapshot.executionId}`);
        let admission = admissions.get(snapshot.executionId);
        if (!admission && loader) { admission = await loader(snapshot); if (admission) admissions.set(snapshot.executionId, admission); }
        while (!admission) {
          // Every queued admission binds its provider and extension before it
          // reaches this rendezvous. No wait/submit can enable the scheduler
          // until all original admissions have reached the same barrier.
          if (!nodeExecution || nodeExecution.state !== 'running' || (store.db.prepare('SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?').get(nodeExecution.task_id, nodeExecution.node_id) as { paused: number } | undefined)?.paused) throw new Error(`Durable recovery is parked: execution ${snapshot.executionId} requires its original Graph admission`);
          await new Promise<void>(resolve => { notifyAdmission = resolve; });
          admission = admissions.get(snapshot.executionId);
        }
        if (JSON.stringify(freezeDurableModel(admission.request.model).model) !== JSON.stringify(snapshot.model) || admission.instructions !== snapshot.agent.instructions || JSON.stringify(admission.configuration) !== JSON.stringify(snapshot.configuration)) throw new Error(`Durable recovery is parked: execution ${snapshot.executionId} requires its original Graph admission`);
        // This request's original provider and tools were restored before this
        // barrier. Its Graph gate still owns the unchanged execution identity.
        continue;
      }
      interrupted.add(Number(id));
      const provider = snapshot.agent.model?.provider;
      if (!provider) throw new Error('Durable recovery is parked: frozen provider missing');
      installDurableModel(models, provider, { model: snapshot.model, stream: () => { throw new Error('Interrupted Graph execution requires inspection before another model request'); } });
      registry.install(defineExtension({ name: snapshot.extensionName, tools: snapshot.tools.map(tool => ({ ...tool, replay: 'unsafe', executionMode: 'sequential', execute: async () => { throw new Error('Interrupted Graph tool requires inspection before execution'); } })) }));
    }
      })().catch(error => { admissions.clear(); recovered = undefined; throw error; });
      return (async () => {
        await registered;
        if (interrupted.size) {
          harness.resume();
          let retiring = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => interrupted.has(task.record.conversationId));
          while (retiring.length) {
            await Promise.all(retiring.map(task => harness.waitForTask(task.record.id, BACKGROUND_CONTEXT)));
            retiring = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => interrupted.has(task.record.conversationId));
          }
          interrupted.clear();
        }
        // Registration is global; waiting is local. A paused node must not
        // prevent another conversation from talking to the main agent.
        if (!ready) return;
        const current = await root.commit(async tx => (await tx.doc(Identities)).conversations[ready.request.binding.instanceId], BACKGROUND_CONTEXT);
        let pending = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => task.record.conversationId === current);
        while (pending.length) {
          await Promise.all(pending.map(task => harness.waitForTask(task.record.id, BACKGROUND_CONTEXT)));
          pending = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => task.record.conversationId === current);
        }
      })();
    };
    return {
      harness, models, registry, recover,
      async frozenExecution(identity: string, executionId: string) {
        const frozen = await root.commit(async tx => {
          const id = (await tx.doc(Identities)).conversations[identity];
          return id === undefined ? undefined : { id, encoded: (await tx.doc(Executions)).conversations[String(id)] };
        }, BACKGROUND_CONTEXT);
        if (!frozen?.encoded) return null;
        const snapshot: FrozenDurableExecution = JSON.parse(frozen.encoded);
        if (snapshot.executionId !== executionId) return null;
        const original = snapshot.originalInputRequestId ?? snapshot.inputRequestId;
        let cursor: Cursor | undefined;
        do {
          const page = await storage.scanSubmissions({ conversationId: frozen.id as ConversationId, order: 'descending' }, 100, cursor, BACKGROUND_CONTEXT);
          const latest = page.items.find(item => item.type === 'input' && item.requestId?.startsWith(original + ':continuation:'));
          if (latest?.requestId) { snapshot.originalInputRequestId = original; snapshot.inputRequestId = latest.requestId; break; }
          cursor = page.next;
        } while (cursor);
        const receipt = await root.commit(tx => tx.submissionByRequest(frozen.id as ConversationId, snapshot.inputRequestId), BACKGROUND_CONTEXT);
        return { snapshot, conversationId: frozen.id, completed: receipt?.type === 'input' && receipt.status === 'done', requestId: snapshot.inputRequestId, attempt: Number(original.match(/:attempt:(\d+)/)?.[1] ?? 0) };
      },
      async pendingAdmissions() {
        const frozen = await root.commit(async tx => ({ ...(await tx.doc(Executions)).conversations }), BACKGROUND_CONTEXT);
        const admissions = [];
        for (const [id, encoded] of Object.entries(frozen)) {
          const snapshot: FrozenDurableExecution = JSON.parse(encoded);
          if (!store.db.prepare("SELECT 1 FROM operations WHERE id=? AND state IN ('unknown','dispatched')").get(snapshot.executionId)) continue;
          let requestId = snapshot.inputRequestId;
          const original = snapshot.originalInputRequestId ?? requestId;
          let cursor: Cursor | undefined;
          do {
            const page = await storage.scanSubmissions({ conversationId: Number(id) as ConversationId, order: 'descending' }, 100, cursor, BACKGROUND_CONTEXT);
            const latest = page.items.find(item => item.type === 'input' && item.requestId?.startsWith(original + ':continuation:'));
            if (latest?.requestId) { requestId = latest.requestId; break; }
            cursor = page.next;
          } while (cursor);
          const receipt = await root.commit(tx => tx.submissionByRequest(Number(id) as ConversationId, requestId), BACKGROUND_CONTEXT);
          if (receipt?.type !== 'input' || receipt.status !== 'done') continue;
          const answer = await root.commit(tx => tx.entry(receipt.answer), BACKGROUND_CONTEXT);
          const assistant = answer?.model?.find(message => message.role === 'assistant');
          if (!assistant) throw new Error('Completed durable input has no assistant answer');
          admissions.push({ executionId: snapshot.executionId, identity: snapshot.identity,
            inputRequestId: original, preAdmissionInvocationIds: snapshot.preAdmissionInvocationIds ?? [],
            finalAssistantText: assistant.content.filter(part => part.type === 'text').map(part => part.text).join(''), stopReason: assistant.stopReason });
        }
        return admissions;
      },
      setRecoveryLoader(value: NonNullable<typeof loader>) { loader = value; },
      async recoverableInput(identity: string, executionId: string) {
        const encoded = await root.commit(async tx => {
          const id = (await tx.doc(Identities)).conversations[identity];
          return id === undefined ? undefined : (await tx.doc(Executions)).conversations[String(id)];
        }, BACKGROUND_CONTEXT);
        if (!encoded) return undefined;
        const snapshot: FrozenDurableExecution = JSON.parse(encoded);
        if (snapshot.executionId !== executionId || (!restoredInputs.has(executionId) && store.db.prepare('SELECT 1 FROM kernel_provider_calls WHERE execution_id=? LIMIT 1').get(executionId))) return undefined;
        const id = await root.commit(async tx => (await tx.doc(Identities)).conversations[identity], BACKGROUND_CONTEXT);
        const receipt = await root.commit(tx => tx.submissionByRequest(id as ConversationId, snapshot.inputRequestId), BACKGROUND_CONTEXT);
        if (!receipt || receipt.status === 'unanswered') return undefined;
        const attempt = Number(snapshot.inputRequestId.match(/:attempt:(\d+)(?::resubmit:\d+)?$/)?.[1]);
        return Number.isSafeInteger(attempt) && attempt > 0 ? { requestId: snapshot.inputRequestId, attempt } : undefined;
      },
      async findConversation(identity: string) {
        const id = await root.commit(async tx => (await tx.doc(Identities)).conversations[identity], BACKGROUND_CONTEXT);
        return id === undefined ? undefined : harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
      },
      async freeze(id: ConversationId, snapshot: FrozenDurableExecution) {
        await root.commit(async tx => { (await tx.doc(Executions)).conversations[String(id)] = JSON.stringify(snapshot); }, BACKGROUND_CONTEXT);
      },
      async conversation(identity: string, agent: AgentChange, init?: (tx: Tx, id: ConversationId) => Promise<void>) {
        const id = await root.commit(async tx => {
          const index = await tx.doc(Identities);
          const existing = index.conversations[identity];
          if (existing !== undefined) return existing as ConversationId;
          const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
          await configure(tx, conversation.id, agent);
          await init?.(tx, conversation.id);
          index.conversations[identity] = conversation.id;
          return conversation.id;
        }, BACKGROUND_CONTEXT);
        const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
        if (!conversation) throw new Error('Durable conversation identity points at missing conversation');
        return conversation;
      },
      async close() { await harness.close(BACKGROUND_CONTEXT); },
    };
  } catch (error) { await storage.close(BACKGROUND_CONTEXT); throw error; }
}
export type DurableHost = Awaited<ReturnType<typeof openDurableHost>>;
