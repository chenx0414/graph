import { workerModelOptions } from './worker-model-options.ts';
import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext } from '@earendil-works/pi-ai';
import type { Api, Model, Context } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RestrictedGate } from './restricted-process.ts';
import { encodeAssistantStream } from './assistant-stream-frames.ts';

export interface WorkerRequestHandler {
  (value: unknown): Promise<unknown>;
  cancel(target: string): boolean;
}

/** Capability targets and model credentials are selected by the host, never the worker. */
export function createWorkerRequests(options: {
  broker: RestrictedGate;
  model: Model<Api>;
  stream: StreamFn;
  resources: Record<string, { url: string; headers?: Record<string, string> }>;
  tools?: Record<string, ToolDefinition>;
  allowedNativeTools?: readonly string[];
  allowedExtensionTools?: readonly string[];
  onEvent?: (event: unknown) => void;
}): WorkerRequestHandler {
  const toolAborts = new Map<string, AbortController>();
  const modelAborts = new Map<string, AbortController>();
  const handle = async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== 'object') throw new Error('Invalid worker request');
    const request = value as Record<string, unknown>;
    if (request.operation === 'model') {
      const target = typeof request.target === 'string' ? request.target : '';
      const abort = new AbortController();
      if (target) modelAborts.set(target, abort);
      try {
        let context: Context;
        if (typeof request.prompt === 'string' && request.prompt.length <= 100_000) {
          context = { messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }] };
        } else {
          const candidate = request.context as Context | undefined;
          if (!candidate || !Array.isArray(candidate.messages)) throw new Error('Invalid model context');
          context = {
            messages: candidate.messages,
            ...(typeof candidate.systemPrompt === 'string' ? { systemPrompt: candidate.systemPrompt } : {}),
            ...(Array.isArray(candidate.tools) ? { tools: candidate.tools } : {}),
          };
        }
        const stream = await options.stream(options.model, normalizeContext(context), { ...workerModelOptions(request.options), signal: abort.signal });
        if (request.events === true) {
          // Every event carries the shared live `partial` message, so the raw
          // event list is quadratic in the response length. Send compact frames
          // plus the terminal settlement instead and let the worker replay them.
          const frames = await encodeAssistantStream(stream);
          return { frames, settlement: await stream.result() };
        }
        return stream.result();
      } finally {
        if (target && modelAborts.get(target) === abort) modelAborts.delete(target);
      }
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
      const id = String(request.id ?? '');
      const abort = new AbortController();
      if (id) toolAborts.set(id, abort);
      try {
        return await tool.execute(id, params as never, abort.signal, undefined, undefined as never);
      } finally {
        if (id && toolAborts.get(id) === abort) toolAborts.delete(id);
      }
    }
    if (request.operation === 'tool_gate') {
      if (typeof request.name !== 'string' || !request.name) throw new Error('Invalid tool name');
      const native = (options.allowedNativeTools ?? []).includes(request.name);
      if (!native && !(options.allowedExtensionTools ?? []).includes(request.name)) {
        return { allowed: false, reason: `Tool ${request.name} is not enabled for this Agent operation` };
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
  const handler = handle as WorkerRequestHandler;
  handler.cancel = (target: string) => {
    const model = modelAborts.get(target);
    if (model) {
      model.abort();
      return true;
    }
    const abort = toolAborts.get(target);
    if (!abort) return false;
    abort.abort();
    return true;
  };
  return handler;
}
