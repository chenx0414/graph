import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Context } from '@earendil-works/pi-ai';
import type { CallBroker } from './call-broker.ts';

/** Capability targets and model credentials are selected by the host, never the worker. */
export function createWorkerRequests(options: {
  broker: CallBroker;
  model: Model<Api>;
  stream: StreamFn;
  resources: Record<string, { url: string; headers?: Record<string, string> }>;
}) {
  return async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== 'object') throw new Error('Invalid worker request');
    const request = value as Record<string, unknown>;
    if (request.operation === 'model') {
      let context: Context;
      if (typeof request.prompt === 'string' && request.prompt.length <= 100_000) {
        context = { messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }] };
      } else {
        const candidate = request.context as Context | undefined;
        if (!candidate || !Array.isArray(candidate.messages) || JSON.stringify(candidate).length > 1_000_000) throw new Error('Invalid model context');
        context = {
          messages: candidate.messages,
          ...(typeof candidate.systemPrompt === 'string' ? { systemPrompt: candidate.systemPrompt } : {}),
          ...(Array.isArray(candidate.tools) ? { tools: candidate.tools } : {}),
        };
      }
      const stream = await options.stream(options.model, context);
      return stream.result();
    }
    if (request.operation === 'read' && typeof request.resource === 'string') {
      const resource = Object.hasOwn(options.resources, request.resource) ? options.resources[request.resource] : undefined;
      if (!resource) throw new Error('Resource not granted');
      const id = randomUUID();
      const response = options.broker.dispatch(id, 0, () => fetch(resource.url, {
        method: 'GET', redirect: 'error', ...(resource.headers ? { headers: resource.headers } : {}),
      }));
      try {
        const result = await response;
        if (!result.ok) throw new Error(`Read failed: ${result.status}`);
        return await result.text();
      } finally { options.broker.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); }
    }
    throw new Error('Operation not granted');
  };
}
