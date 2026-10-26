import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted answer of the Anthropic Messages provider. */
export interface AnthropicMessagesPlan {
  /** The tool the provider calls. */
  tool?: { id: string; name: string; input: Record<string, unknown> };
  /** The text the provider answers with. */
  text?: string;
  /** End the response without the `message_stop` marker. */
  cut?: boolean;
}

export interface AnthropicMessagesRequest {
  body: {
    model?: string;
    system?: unknown;
    messages?: { role: string; content: unknown }[];
    tools?: unknown[];
    max_tokens?: number;
  };
}

/**
 * A scripted Anthropic Messages provider: one plan per request, in arrival order.
 *
 * Only the external vendor is replaced. The daemon, the kernel, the tool bodies
 * and the persistence stay real, so the recorded request bodies are the ones a
 * real provider would have received.
 */
export async function anthropicMessagesServer(plans: AnthropicMessagesPlan[]) {
  const requests: AnthropicMessagesRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) });
    const plan = plans.shift() ?? { text: 'Unexpected extra request' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const write = (payload: Record<string, unknown>) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    write({
      type: 'message_start',
      message: {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null,
        usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    let index = 0;
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
    if (plan.cut) {
      // The connection closes before the message ends: the provider said how the
      // turn ended, but never closed the message.
      res.end();
      return;
    }
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
