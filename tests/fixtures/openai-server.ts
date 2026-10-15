import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

export interface ResponsePlan {
  text?: string;
  /** Stream the answer as these content deltas instead of one block. */
  chunks?: string[];
  thinking?: string;
  /** Valid SSE comments, ignored by the model client but still part of transport evidence. */
  comments?: string[];
  tools?: { id: string; name: string; arguments: string | (() => string) }[];
  finishReason?: 'stop' | 'length' | 'tool_calls';
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number }; completion_tokens_details?: { reasoning_tokens: number } } | null;
  status?: number;
  error?: string;
  /** Vendor error code; defaults to context overflow for existing compaction fixtures. */
  errorCode?: string;
  redirect?: string;
  /** Keep the HTTP response open after the SSE [DONE] marker. */
  holdOpen?: boolean;
  beforeReply?: () => Promise<void> | void;
}
/**
 * A scripted provider: one plan per request, in arrival order.
 *
 * That includes requests the SDK makes for itself - notably the summary it asks for when it compacts a
 * long conversation, which carries a preamble of its own and is not the master speaking. A test that
 * wants such a summary answered scripts it as a plan (tests/m0/agent-session-contract.test.ts does); a
 * test that counts provider requests must therefore say whether it means requests or the master's turns
 * (tests/console/rsi-reload.test.ts learned this the hard way - counting requests made an assertion that
 * passed in every direct run fail three times on the activation gate, because a summary had taken the
 * plan the continuation was meant to speak). Do not special-case summaries here.
 */
export async function openaiServer(plans: ResponsePlan[]) {
  const requests: unknown[] = [];
  const authorizations: string[] = [];
  const headerList: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (!body.trim()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty request body' }));
      return;
    }
    requests.push(JSON.parse(body));
    authorizations.push(req.headers.authorization ?? '');
    headerList.push(Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])));
    const plan = plans.shift() ?? { text: 'Unexpected extra request' };
    await plan.beforeReply?.();
    if (plan.status) {
      res.writeHead(plan.status, { 'content-type': 'application/json', ...(plan.redirect ? { location: plan.redirect } : {}) });
      res.end(JSON.stringify({ error: { message: plan.error ?? 'Service unavailable', type: 'invalid_request_error', code: plan.errorCode ?? 'context_length_exceeded' }, usage: plan.usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const comment of plan.comments ?? []) res.write(`: ${comment}\n\n`);
    const delta: Record<string, unknown> = { role: 'assistant' };
    if (plan.thinking) delta.reasoning_content = plan.thinking;
    if (plan.tools) {
      delta.tool_calls = plan.tools.map((tool, index) => ({
        index,
        id: tool.id,
        type: 'function',
        function: { name: tool.name, arguments: typeof tool.arguments === 'function' ? tool.arguments() : tool.arguments },
      }));
    } else if (!plan.thinking) {
      delta.content = plan.text ?? 'Local response';
    }
    const finishReason = plan.finishReason ?? (plan.tools ? 'tool_calls' : 'stop');
    if (plan.chunks) {
      for (const chunk of plan.chunks) {
        res.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta: { role: 'assistant', content: chunk }, finish_reason: null }] })}\n\n`);
      }
      if (plan.tools) {
        res.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta: { tool_calls: delta.tool_calls }, finish_reason: null }] })}\n\n`);
      }
    } else {
      res.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: 'response', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: plan.usage === undefined ? { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 15 }, completion_tokens_details: { reasoning_tokens: 3 } } : plan.usage })}\n\n`);
    if (plan.holdOpen) res.write('data: [DONE]\n\n');
    else res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model<'openai-completions'> = {
    id: 'local', name: 'Local scripted OpenAI', provider: 'graph-openai', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('graph-openai', { baseUrl, api: 'openai-completions', apiKey: 'scripted-local-key', models: [model] });
  return { model, runtime, requests, authorizations, headerList, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
