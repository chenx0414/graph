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
