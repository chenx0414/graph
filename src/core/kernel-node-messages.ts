import { appendMessage } from './conversation.ts';
import { wakeMaster } from './wake-ledger.ts';
import type { KernelStore } from './kernel-store.ts';
import { GraphRuntime } from './graph-runtime.ts';
import { appendNodeEntry } from './node-run.ts';
import { RuntimeError } from './types.ts';

/** Chat is one durable queue item, never steering or implicit descendant invalidation. */
export function sendKernelNodeMessage(kernel: KernelStore, graphId: string, nodeId: string,
  input: { text: string; requestId: string }, from?: string) {
  const text = input.text?.trim();
  if (!text || text.length > 100_000) throw new RuntimeError('invalid_input', 'A message of 1–100000 characters is required');
  const actor = from === undefined ? 'user' : `peer:${from}`;
  return kernel.store.command(`node-message:${graphId}:${nodeId}:${actor}`, input.requestId, { text, from: from ?? null }, () => {
    const nodes = kernel.latestRevision(graphId)?.definition.nodes;
    if (from !== undefined && (!nodes || !Object.hasOwn(nodes, from) || from === nodeId)) {
      throw new RuntimeError('invalid_input', 'A peer sender must be another agent of this graph');
    }
    const queued = new GraphRuntime(kernel, graphId).chat({ nodeId, text: from === undefined ? text : `From ${from}: ${text}` }, from !== undefined);
    const instance = kernel.listNodes(graphId).find(node => node.nodeId === nodeId)!;
    appendNodeEntry(kernel.store, { taskId: graphId, nodeId, instanceId: instance.instanceId,
      role: from === undefined ? 'user' : 'assistant', kind: 'chat', text,
      data: { requestId: input.requestId, queueSeq: queued.seq, ...(from === undefined ? {} : { from, peer: true }) } });
    return { queued: true, seq: queued.seq, taskId: graphId, nodeId };
  });
}

/** The external graph owner receives chat in its existing conversation, not a graph node. */
export function sendKernelMainMessage(kernel: KernelStore, graphId: string, from: string,
  input: { text: string; requestId: string }) {
  const text = input.text?.trim();
  if (!text || text.length > 100_000) throw new RuntimeError('invalid_input', 'A message of 1–100000 characters is required');
  return kernel.store.command(`node-message:${graphId}:main:peer:${from}`, input.requestId, { text, from }, () => {
    const graph = new GraphRuntime(kernel, graphId);
    const nodes = kernel.latestRevision(graphId)?.definition.nodes;
    if (!nodes || !Object.hasOwn(nodes, from)) throw new RuntimeError('invalid_input', 'A peer sender must be an agent of this graph');
    const phase = graph.state()!.phase;
    if (phase === 'completed') throw new RuntimeError('completing', `Graph ${graphId} is completed; chat is closed`);
    if (phase === 'stopping' || phase === 'stopped') throw new RuntimeError('stopping', `Graph ${graphId} is stopping; chat is closed`);
    const task = kernel.store.task(graphId);
    if (!task.conversation_id) throw new RuntimeError('invalid_input', 'Graph has no owning conversation');
    const message = appendMessage(kernel.store, { conversationId: task.conversation_id, role: 'user', kind: 'peer',
      text: `[${from}](graph://${graphId}/agents/${encodeURIComponent(from)}): ${text}`, state: 'pending',
      data: { graphId, nodeId: from, requestId: input.requestId } });
    wakeMaster(kernel.store, { taskId: graphId, kind: 'peer_message', dedupeKey: message.id, data: { graphId, nodeId: from, messageId: message.id } });
    return message;
  });
}
