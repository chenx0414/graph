import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AnthropicPlan {
  /** The reasoning the provider streams before its answer. */
  thinking?: string;
  /** The signature the provider signs its reasoning with. */
  signature?: string;
  /** The opaque payload of a reasoning block the provider keeps for itself. */
  redacted?: string;
  /** The tool the provider calls. */
  tool?: { id: string; name: string; input: Record<string, unknown> };
  /** The text the provider answers with. */
  text?: string;
}

export interface AnthropicRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    system?: unknown;
    messages?: { role: string; content: unknown }[];
    tools?: unknown[];
  };
}

/**
 * A scripted Anthropic Messages provider: one plan per request, in arrival order.
 *
 * Only the external vendor is replaced. The daemon, the kernel, the tool bodies and
 * the persistence stay real, so the recorded request bodies are the ones a real
 * provider would have received.
 */
export async function anthropicServer(plans: AnthropicPlan[]) {
  const requests: AnthropicRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url ?? '',
      headers: Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])),
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    const plan = plans.shift() ?? { text: 'Unexpected extra request' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const write = (payload: Record<string, unknown>) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    write({
      type: 'message_start',
      message: {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null,
        usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 15, cache_creation_input_tokens: 0 },
      },
    });
    let index = 0;
    if (plan.thinking !== undefined || plan.redacted !== undefined) {
      write({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      if (plan.thinking !== undefined) {
        write({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: plan.thinking } });
      }
      if (plan.signature !== undefined) {
        write({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: plan.signature } });
      }
      if (plan.redacted !== undefined) {
        write({ type: 'content_block_delta', index, delta: { type: 'redacted_delta', data: plan.redacted } });
      }
      write({ type: 'content_block_stop', index });
      index += 1;
    }
    if (plan.tool) {
      write({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: plan.tool.id, name: plan.tool.name, input: {} } });
      write({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan.tool.input) } });
      write({ type: 'content_block_stop', index });
      index += 1;
    }
    if (plan.text !== undefined) {
      write({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      write({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: plan.text } });
      write({ type: 'content_block_stop', index });
    }
    write({ type: 'message_delta', delta: { stop_reason: plan.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } });
    write({ type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}
