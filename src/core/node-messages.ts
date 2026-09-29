import type { TaskStore } from './store.ts';
import { canonicalJson } from './store.ts';
import type { Execution } from './execution.ts';
import { activeOperationForNode } from './control-targets.ts';
import { hasLockedQuestion, loadGraph, reactivate, supersedeOpenQuestions } from './graph.ts';
import { appendNodeEntry } from './node-run.ts';
import { RuntimeError, type NodeSpec } from './types.ts';

/** User messages address an instance, never the conversation master. Rework uses
 * the graph's normal invalidation and admission rules, including budget/session continuity. */
export async function sendNodeMessage(store: TaskStore, execution: Execution, taskId: string, nodeId: string, input: { text: string; requestId: string }) {
  return deliverToNode(store, execution, taskId, nodeId, { ...input, provenance: null });
}

/**
 * One Agent of a graph talking to another (`send_to_peer`).
 *
 * The message is delivered to the target exactly like a user message: it steers the target's
 * running turn, or reactivates a finished target and becomes the input of its next dispatch, so it
 * shows up in the target's own chat window and reaches its next briefing as a prompt. That is the
 * whole point - a peer's words are a prompt, not a passive row in an inbox. The graph may route a
 * message back along the same edge (A -> B -> A) as many times as the Agents choose; there is no
 * round-trip cap, and a message to a succeeded node reactivates it on purpose.
 *
 * `provenance.from` is the sending node id. It rides on the node entry so the target's chat can
 * say the words came from a peer Agent rather than pretending they are the user speaking.
 */
export async function sendPeerMessage(store: TaskStore, execution: Execution, taskId: string, from: string, input: { to: string; text: string; requestId: string }) {
  const peerNodes = graphNodeIds(store, taskId);
  if (!peerNodes.includes(input.to)) throw new RuntimeError('invalid_input', `节点 ${input.to} 不属于当前任务图`);
  if (input.to === from) throw new RuntimeError('invalid_input', '不能给自己发送节点消息');
  return deliverToNode(store, execution, taskId, input.to, { text: input.text, requestId: input.requestId, provenance: { from } });
}

function graphNodeIds(store: TaskStore, taskId: string): string[] {
  return (store.db.prepare('SELECT id FROM nodes WHERE task_id=?').all(taskId) as { id: string }[]).map(row => row.id);
}

async function deliverToNode(
  store: TaskStore,
  execution: Execution,
  taskId: string,
  nodeId: string,
  input: { text: string; requestId: string; provenance: { from: string } | null },
) {
  const text = input.text?.trim();
  if (!text || text.length > 100_000 || !input.requestId || input.requestId.length > 200) throw new RuntimeError('invalid_input', '消息和 requestId 不能为空，消息最多 100000 字符');
  const scope = `node-message:${taskId}:${nodeId}`;
  const payload = { text };
  const previous = store.db.prepare('SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?').get(scope, input.requestId) as { payload: string; receipt: string } | undefined;
  if (previous) {
    if (previous.payload !== canonicalJson(payload)) throw new RuntimeError('idempotency_conflict', '该请求编号已用于另一条消息');
    const receipt = JSON.parse(previous.receipt) as { state: string; taskId: string; nodeId: string };
    if (receipt.state === 'sending' || receipt.state === 'uncertain') throw new RuntimeError('delivery_uncertain', '消息正在发送或送达状态待核对，请先查看节点记录，勿重复发送');
    return receipt;
  }
  const task = store.task(taskId);
  const node = store.db.prepare('SELECT spec,instance_id,activation_id,status FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { spec: string; instance_id: string | null; activation_id: string; status: string } | undefined;
  if (!node) throw new RuntimeError('not_found', '节点不存在');
  const spec = JSON.parse(node.spec) as NodeSpec;
  if (spec.kind !== 'agent' || !node.instance_id || spec.role === 'master') throw new RuntimeError('invalid_input', '只能向子 Agent 节点发送消息');
  if (['abandoned', 'discussing', 'chatting'].includes(task.phase)) throw new RuntimeError('invalid_state', '当前任务不能向子 Agent 发送消息');
  const active = activeOperationForNode(store, taskId, nodeId);
  if (active) {
    store.command(scope, input.requestId, payload, () => ({ taskId, nodeId, state: 'sending' }));
    try {
      const delivered = await execution.steer(active.id, text);
      return store.transaction(() => {
        appendNodeEntry(store, { taskId, nodeId, instanceId: node.instance_id, activationId: node.activation_id, operationId: active.id,
          role: input.provenance ? 'assistant' : 'user', kind: 'chat', text,
          data: { requestId: input.requestId, ordinal: delivered?.ordinal ?? null, ...(input.provenance ? { from: input.provenance.from, peer: true } : {}) } });
        const receipt = { taskId, nodeId, state: 'steered', operationId: active.id };
        store.db.prepare('UPDATE commands SET receipt=? WHERE scope=? AND request_id=?').run(canonicalJson(receipt), scope, input.requestId);
        return receipt;
      });
    } catch (error) {
      store.db.prepare('UPDATE commands SET receipt=? WHERE scope=? AND request_id=?').run(canonicalJson({ taskId, nodeId, state: 'uncertain' }), scope, input.requestId);
      throw error;
    }
  }
  return store.command(scope, input.requestId, payload, () => {
    const graph = loadGraph(store, taskId);
    if (!graph.plan.nodes.has(nodeId)) throw new RuntimeError('invalid_state', '节点不属于当前任务图');
    const affected = [nodeId, ...graph.plan.dependents(nodeId)];
    for (const id of affected) {
      const live = store.db.prepare("SELECT id FROM operations WHERE task_id=? AND node_id=? AND (worker_active=1 OR state IN ('prepared','dispatched','unknown')) LIMIT 1").get(taskId, id);
      if (live) throw new RuntimeError('node_busy', '受影响节点仍在执行或等待核对，请待其结束后再发起返工');
      if (hasLockedQuestion(store, taskId, id)) throw new RuntimeError('node_blocked', '请先处理受影响节点的权限、预算或核对问题');
    }
    // Multiple messages before dispatch belong to the same pending rework.
    // Replacing that activation would silently drop the earlier instructions.
    const queuedRework = node.status === 'pending' && store.db.prepare(
      "SELECT id FROM node_entries WHERE task_id=? AND node_id=? AND json_extract(data,'$.reworkActivation')=? LIMIT 1",
    ).get(taskId, nodeId, node.activation_id);
    if (!queuedRework) reactivate(store, taskId, nodeId);
    for (const id of affected) supersedeOpenQuestions(store, taskId, id);
    const activation = store.db.prepare('SELECT activation_id FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { activation_id: string };
    appendNodeEntry(store, { taskId, nodeId, instanceId: node.instance_id, activationId: activation.activation_id,
      role: input.provenance ? 'assistant' : 'user', kind: 'chat', text,
      data: { requestId: input.requestId, reworkActivation: activation.activation_id, ...(input.provenance ? { from: input.provenance.from, peer: true } : {}) } });
    const runtime = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    store.db.prepare('UPDATE tasks SET phase=? WHERE id=?').run(runtime.active_task && runtime.active_task !== taskId ? 'queued' : 'running', taskId);
    if (!runtime.active_task) store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
    store.event(taskId, 'node.user_rework', { nodeId, affected, requestId: input.requestId });
    return { taskId, nodeId, state: 'rework', affected };
  });
}
