import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentSessionRequest } from './agent-session.ts';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { StreamFunction } from '@earendil-works/pi-ai';
import type { MutableModels } from '@earendil-works/pi-ai/models';

/** Expand-contract bridge: the frozen Graph provider callback remains the
 * owner of auth, credential slots, raw usage evidence and budget admission.
 * Durable owns generation; it never opens an ungated provider channel. */
export function installDurableModel(models: MutableModels, name: string, request: Pick<AgentSessionRequest, 'model' | 'stream'>, stopping: () => boolean = () => false) {
  const stream: StreamFunction = (_model, transcript, options) => {
    const output = new AssistantMessageEventStream();
    void (async () => {
      if (stopping()) {
        output.push({ type: 'error', reason: 'aborted', error: { role: 'assistant', api: request.model.api, provider: name, model: request.model.id, content: [], stopReason: 'aborted', errorMessage: 'Turn stopped at the tool boundary', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
        return;
      }
      const source = await request.stream(request.model, normalizeContext({ messages: transcript.messages }), options);
      let terminal = false;
      for await (const event of source) {
        terminal ||= event.type === 'done' || event.type === 'error';
        output.push(event);
      }
      if (!terminal) throw new Error('Provider stream ended without a terminal event');
    })().catch(error => {
      const message = { role: 'assistant' as const, api: request.model.api, provider: name, model: request.model.id,
        content: [], stopReason: 'error' as const, errorMessage: String(error), timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: 'error', reason: 'error', error: message });
    });
    return output;
  };
  const forward = { stream, streamSimple: stream };
  models.setProvider(createProvider({ id: name,
    auth: { apiKey: { name: 'Frozen Graph binding', resolve: async () => ({ auth: { apiKey: 'graph-gated-binding' } }) } },
    models: [{ ...request.model, provider: name }], api: forward,
  }));
  return { provider: name, modelId: request.model.id };
}
export { createModels };
