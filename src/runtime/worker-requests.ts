import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model, Context, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RestrictedGate } from './restricted-process.ts';

/** Capability targets and model credentials are selected by the host, never the worker. */
export function createWorkerRequests(options: {
  broker: RestrictedGate;
  model: Model<Api>;
  stream: StreamFn;
  resources: Record<string, { url: string; headers?: Record<string, string> }>;
  tools?: Record<string, ToolDefinition>;
  allowedExtensionTools?: readonly string[];
  onEvent?: (event: unknown) => void;
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
      if (request.events === true) {
        const events: AssistantMessageEvent[] = [];
        for await (const event of stream) events.push(event);
        return { events };
      }
      return stream.result();
    }
    if (request.operation === 'event') {
      options.onEvent?.(request.event);
      return null;
    }
    if (request.operation === 'tool') {
      if (typeof request.name !== 'string' || !request.name) throw new Error('Invalid tool name');
      const tool = options.tools && Object.hasOwn(options.tools, request.name) ? options.tools[request.name] : undefined;
      if (!tool) throw new Error(`Tool not granted: ${request.name}`);
      const params = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
      return tool.execute(String(request.id ?? ''), params as never, undefined, undefined, undefined as never);
    }
    if (request.operation === 'tool_gate') {
      if (typeof request.name !== 'string' || !request.name) throw new Error('Invalid extension tool name');
      if (!(options.allowedExtensionTools ?? []).includes(request.name)) {
        return { allowed: false, reason: `Pi extension tool ${request.name} is not declared by the bound capability` };
      }
      const id = randomUUID();
      try {
        options.broker.dispatch(id, 0, () => undefined);
        options.broker.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        return { allowed: true };
      } catch (error) {
        return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
      }
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
