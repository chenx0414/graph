import { createHash } from 'node:crypto';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';

/** Transport observations, not billing attribution. No request text or credentials are retained. */
export function profileProviderRequest(body: unknown) {
  if (typeof body !== 'string') return null;
  const request = JSON.parse(body) as Record<string, unknown>;
  const sections: Record<string, { bytes: number; estimatedTokens: number }> = {};
  const add = (source: string, value: unknown) => {
    if (value === undefined) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const section = sections[source] ??= { bytes: 0, estimatedTokens: 0 };
    section.bytes += Buffer.byteLength(text);
    section.estimatedTokens += estimateTextTokens(text);
  };
  add('tools', request.tools);
  add('system', request.system);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemMessages: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const item = message as Record<string, unknown>;
    const role = item.role;
    if (role === 'system' || role === 'developer') {
      systemMessages.push(message);
      add('system', message);
    } else if (role === 'tool') add('tool_results', message);
    else if (role === 'user' && Array.isArray(item.content)) {
      // Anthropic encodes tool results inside user messages. Preserve mixed user blocks.
      for (const block of item.content) add(block?.type === 'tool_result' ? 'tool_results' : 'user', block);
    } else add(role === 'assistant' ? 'assistant_history' : 'user', message);
  }
  const prefix = JSON.stringify({ tools: request.tools, system: request.system, systemMessages });
  return {
    version: 1,
    requestBytes: Buffer.byteLength(body),
    sections,
    staticFingerprint: createHash('sha256').update(prefix).digest('hex'),
    // A breakpoint is configuration evidence only; actual cache hits come from usage.
    explicitCacheControls: (body.match(/"cache_control"\s*:/g) ?? []).length,
  };
}
