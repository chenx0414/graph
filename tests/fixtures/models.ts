import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import type { ControlledStream as StreamFn } from '../../src/runtime/controlled-openai.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export const modelA: Model<Api> = {
  id: 'model-a', name: 'Local A', api: 'graph-test', provider: 'graph-test',
  baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000, maxTokens: 256,
};
export const modelB: Model<Api> = { ...modelA, id: 'model-b', name: 'Local B' };

export function reply(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: model.api,
    provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export const respond: StreamFn = (model) => {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: reply(model, 'Saved response') });
  return stream;
};

export async function testModelRuntime() {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider('graph-test', {
    api: 'graph-test', apiKey: 'local-test-placeholder',
    baseUrl: modelA.baseUrl, streamSimple: (model, context, options) => {
      const result = respond(model, context, options);
      if (result instanceof Promise) throw new Error('Fixture must return a stream');
      return result;
    },
    models: [modelA, modelB],
  });
  return runtime;
}
