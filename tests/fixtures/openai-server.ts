import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

export interface ResponsePlan {
  text?: string;
  tools?: { id: string; name: string; arguments: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number }; completion_tokens_details?: { reasoning_tokens: number } } | null;
  status?: number;
  error?: string;
  redirect?: string;
  beforeReply?: () => Promise<void> | void;
}
export async function openaiServer(plans: ResponsePlan[]) {
  const requests: unknown[] = [];
  const authorizations: string[] = [];
  const headerList: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    authorizations.push(req.headers.authorization ?? '');
    headerList.push(Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])));
    const plan = plans.shift() ?? { text: 'Unexpected extra request' };
    await plan.beforeReply?.();
    if (plan.status) {
      res.writeHead(plan.status, { 'content-type': 'application/json', ...(plan.redirect ? { location: plan.redirect } : {}) });
      res.end(JSON.stringify({ error: { message: plan.error ?? 'Service unavailable', type: 'invalid_request_error', code: 'context_length_exceeded' }, usage: plan.usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = plan.tools
      ? { role: 'assistant', tool_calls: plan.tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) }
      : { role: 'assistant', content: plan.text ?? 'Local response' };
    res.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'response', choices: [{ index: 0, delta: {}, finish_reason: plan.tools ? 'tool_calls' : 'stop' }], usage: plan.usage === undefined ? { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 15 }, completion_tokens_details: { reasoning_tokens: 3 } } : plan.usage })}\n\n`);
    res.end('data: [DONE]\n\n');
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
