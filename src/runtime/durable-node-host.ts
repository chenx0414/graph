import type { KernelStore } from '../core/kernel-store.ts';
import type { RunnerHost } from '../core/graph-runner.ts';
import { recordNodeSession } from '../core/node-run.ts';
import type { AgentSession, AgentSessionRequest, AgentSessionTransport } from './agent-session.ts';
import { tokenUsageTotal } from './call-broker.ts';

/** Graph supplies explicit inputs and judges outputs; the shared durable host
 * owns the conversation, model/tool tasks and their checkpoints. A continuation
 * gets its own input receipt without replacing the execution configuration. */
export function durableNodeHost(options: {
  transport: AgentSessionTransport;
  kernel: KernelStore;
  graphId: string;
  nodeId: string;
  request: AgentSessionRequest;
}): RunnerHost & { stop(): Promise<void>; dispose(): Promise<void>; recoveryRequest(): AgentSessionRequest } {
  let closed = false;
  let current: AgentSession | undefined;
  return {
    recoveryRequest: () => options.request,
    alive: () => !closed,
    recoveredAttempt: async () => (await options.transport.recoverableInput?.(options.request.binding.instanceId, options.request.executionId!))?.attempt,
    async start() {
      if (closed) throw new Error('Durable node binding is closed');
      return { processId: process.pid };
    },
    async turn(text, input) {
      if (closed) throw new Error('Durable node binding is closed');
      if (!input || input.executionId !== options.request.executionId) throw new Error('Durable input does not match its frozen execution');
      const resubmits = options.kernel.execution(input.executionId)?.resubmitsUsed ?? 0;
      const requestId = `${input.executionId}:attempt:${input.attempt}${resubmits ? `:resubmit:${resubmits}` : ''}`;
      const resumed = await options.transport.recoverableInput?.(options.request.binding.instanceId, input.executionId);
      const priorCalls = new Set(options.kernel.providerCalls(options.graphId, options.nodeId).map(call => call.id));
      const session = await options.transport.open({ ...options.request, inputRequestId: requestId });
      current = session;
      const inspection = session.inspect();
      recordNodeSession(options.kernel.store, options.request.binding.instanceId, inspection.sessionId, inspection.sessionFile);
      try {
        const result = await session.prompt(text);
        const calls = options.kernel.providerCalls(options.graphId, options.nodeId).filter(call => (!priorCalls.has(call.id) || resumed?.requestId === requestId) && call.executionId === input.executionId);
        // Durable's SDK usage has no evidence grade. Only the existing Graph
        // provider receipts can release a reservation and avoid double charging.
        const rejectedBeforeSend = calls.length === 0 && result.errorMessage && /paused/i.test(result.errorMessage);
        const known = rejectedBeforeSend || calls.length > 0 && calls.every(call => call.usage !== null && ['settled', 'reconciled'].includes(call.state));
        return { turnId: requestId, inspect: result.inspect,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
          ...(known ? { usage: { total: calls.reduce((sum, call) => sum + tokenUsageTotal(call.usage!), 0), accounted: true } } : {}) };
      } finally {
        if (current === session) current = undefined;
        await session.close();
      }
    },
    async stop() { await current?.stop(); },
    async dispose() { closed = true; await current?.interrupt(); await current?.close(); },
  };
}
