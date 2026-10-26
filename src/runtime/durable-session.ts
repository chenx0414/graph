import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { watchEvents,type SubmissionRecord } from '@earendil-works/pi-durable';
import type { TaskStore } from '../core/store.ts';
import type { AgentSessionRequest,AgentSessionTransport } from './agent-session.ts';
import { freezeDurableModel } from './durable-freeze.ts';
import { openDurableHost,type FrozenDurableExecution } from './durable-host.ts';
import { createModels } from './durable-models.ts';
import { prepareDurableSession } from './durable-session-prepare.ts';

/** One durable conversation transport for main and Graph nodes. Native tools
 * and capability hooks share the frozen Graph policy and provider gate. */
export async function createDurableSessionTransport(store: TaskStore): Promise<AgentSessionTransport & { host: Awaited<ReturnType<typeof openDurableHost>>; close(): Promise<void> }> {
  const host = await openDurableHost(store, createModels());
  const recovering = new Set<Promise<void>>();
  const beginRecovery = new Set<() => void>();
  const restored = new Set<() => Promise<void>>();
  const recoveredConfigurations = new Map<string, FrozenDurableExecution>();
  const factories = new Set<(snapshot: FrozenDurableExecution, receipt?: SubmissionRecord) => Promise<AgentSessionRequest | undefined>>();
  const prepare = (request: AgentSessionRequest, restoring?: FrozenDurableExecution) => prepareDurableSession(host, store, request, restoring);
  host.setRecoveryLoader(async snapshot => {
    for (const factory of factories) {
      const original = await host.findConversation(snapshot.identity);
      const receipt = original && await original.commit(tx => tx.submissionByRequest(original.id, snapshot.inputRequestId), BACKGROUND_CONTEXT);
      const request = await factory(snapshot, receipt);
      if (!request) continue;
      if (request.executionId !== snapshot.executionId || request.binding.instanceId !== snapshot.identity || JSON.stringify(freezeDurableModel(request.model).model) !== JSON.stringify(snapshot.model)) throw new Error('Recovery factory changed an original admission');
      if (receipt?.type === 'input' && receipt.status === 'done' && request.onRecoveryComplete && original) {
        const answer = await original.commit(tx => tx.entry(receipt.answer), BACKGROUND_CONTEXT);
        const assistant = answer?.model?.find((message): message is AssistantMessage => message.role === 'assistant');
        if (!assistant) throw new Error('Completed durable receipt has no assistant answer');
        beginRecovery.add(() => {
          const completed = (async () => {
            const context = await original.context(BACKGROUND_CONTEXT);
            request.onEvent?.({ type: 'message_start', message: assistant });
            request.onEvent?.({ type: 'message_end', message: assistant });
            await request.onRecoveryComplete!({ inspect: { binding: request.binding, sessionId: String(original.id), sessionFile: `durable:${original.id}`, model: request.model.id, messages: [...context.messages], leafId: null, bundleDigest: request.bundleDigest, toolPolicyDigest: request.toolPolicyDigest, runtimePolicyDigest: request.runtimePolicyDigest, piVersion: '1.1.0' }, finalAssistantText: assistant.content.filter(part => part.type === 'text').map(part => part.text).join(''), stopReason: assistant.stopReason });
          })();
          recovering.add(completed);
          void completed.finally(() => { recovering.delete(completed); }).catch(() => undefined);
        });
        return { request, instructions: snapshot.agent.instructions ?? '', configuration: snapshot.configuration };
      }
      recoveredConfigurations.set(snapshot.executionId, snapshot);
      const session = await prepare({ ...request, inputRequestId: snapshot.inputRequestId }, snapshot);
      restored.add(async () => { try { await session.close(); } finally { await request.onRecoveryClose?.(); } });
      if (request.onRecoveryComplete) {
        const conversation = await host.findConversation(snapshot.identity);
        if (!conversation) throw new Error('Original recovery conversation is missing');
        const receipt = await conversation.commit(tx => tx.submissionByRequest(conversation.id, snapshot.inputRequestId), BACKGROUND_CONTEXT);
        if (!receipt) throw new Error('Original recovery input receipt is missing');
        const input = await host.harness.submission(receipt.id, BACKGROUND_CONTEXT);
        if (!input) throw new Error('Original recovery input is missing');
        const events = await watchEvents(host.harness, conversation.id, BACKGROUND_CONTEXT);
        let assistant: AssistantMessage | undefined;
        if (receipt.type === 'input' && receipt.status === 'done') { const answer = await conversation.commit(tx => tx.entry(receipt.answer), BACKGROUND_CONTEXT); assistant = answer?.model?.find((message): message is AssistantMessage => message.role === 'assistant'); }
        events.start(async batch => {
          for (const event of batch) {
            if (event.type === 'message_start') request.onEvent?.({ type: 'message_start', message: event.message });
            if (event.type === 'message_end') for (const message of event.entry.model ?? []) {
              if (message.role === 'assistant') assistant = message;
              request.onEvent?.({ type: 'message_end', message });
            }
            if (event.type === 'tool_execution_start') request.onEvent?.({ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
          }
        });
        beginRecovery.add(() => {
          const completed = (async () => {
            try {
              const result = await input.wait(BACKGROUND_CONTEXT);
              await events.stop();
              if (result.status === 'done') {
                // Event delivery can lag the settled input under load. The
                // original durable answer is the authoritative completion.
                const settled = await conversation.commit(tx => tx.submissionByRequest(conversation.id, snapshot.inputRequestId), BACKGROUND_CONTEXT);
                if (settled?.type !== 'input' || settled.status !== 'done') throw new Error('Recovered input lacks its completed receipt');
                const answer = await conversation.commit(tx => tx.entry(settled.answer), BACKGROUND_CONTEXT);
                assistant = answer?.model?.find((message): message is AssistantMessage => message.role === 'assistant');
              }
              const finalAssistantText = assistant?.content.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
              await request.onRecoveryComplete!({ inspect: session.inspect(), finalAssistantText, stopReason: result.status === 'done' ? assistant?.stopReason ?? 'stop' : 'error',
                ...(result.status === 'done' && assistant ? {} : { errorMessage: String(result.status === 'done' ? 'Recovered input has no new assistant response' : result.detail ?? result.reason) }) });
            } finally { await events.stop(); }
          })();
          recovering.add(completed);
          void completed.finally(() => { recovering.delete(completed); }).catch(() => undefined);
        });
      }
      return { request, instructions: snapshot.agent.instructions ?? '', configuration: snapshot.configuration };
    }
    return undefined;
  });
  return { host, close: async () => { try { await host.close(); } finally { await Promise.allSettled([...recovering]); await Promise.allSettled([...restored].map(close => close())); restored.clear(); } }, recoverableInput: host.recoverableInput, open: request => prepare(request, request.executionId ? recoveredConfigurations.get(request.executionId) : undefined),
    async bootstrapRecovery() { await host.recover(); for (const begin of beginRecovery) begin(); beginRecovery.clear(); host.harness.resume(); },
    async waitForRecovery() { await Promise.all([...recovering]); },
    registerRecoveryFactory(factory) { factories.add(factory); return () => { factories.delete(factory); }; },
  };
}
