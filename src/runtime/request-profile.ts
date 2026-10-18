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
    const size = { bytes: Buffer.byteLength(text), estimatedTokens: estimateTextTokens(text) };
    const section = sections[source] ??= { bytes: 0, estimatedTokens: 0 };
    section.bytes += size.bytes;
    section.estimatedTokens += size.estimatedTokens;
    return size;
  };
  add('tools', request.tools);
  add('system', request.system);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  // Only retain names declared on this request. Call IDs and arguments stay local
  // to profiling; unmatched historical results remain explicitly unattributed.
  const declaredNames = new Set<string>();
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === 'string') declaredNames.add(name);
  }
  const calls = new Map<string, string | null>();
  const toolResults = new Map<string | null, { tool: string | null; resultViews: number; bytes: number; estimatedTokens: number }>();
  const remember = (id: unknown, name: unknown) => {
    if (typeof id === 'string') calls.set(id, typeof name === 'string' && declaredNames.has(name) ? name : null);
  };
  const addResult = (value: unknown, id: unknown) => {
    const size = add('tool_results', value);
    if (!size) return;
    const tool = typeof id === 'string' ? calls.get(id) ?? null : null;
    const row = toolResults.get(tool) ?? { tool, resultViews: 0, bytes: 0, estimatedTokens: 0 };
    row.resultViews++;
    row.bytes += size.bytes;
    row.estimatedTokens += size.estimatedTokens;
    toolResults.set(tool, row);
  };
  const systemMessages: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const item = message as Record<string, unknown>;
    const role = item.role;
    if (role === 'assistant') {
      for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) remember(call?.id, call?.function?.name);
      for (const block of Array.isArray(item.content) ? item.content : []) if (block?.type === 'tool_use') remember(block.id, block.name);
    }
    if (role === 'system' || role === 'developer') {
      systemMessages.push(message);
      add('system', message);
    } else if (role === 'tool') addResult(message, item.tool_call_id);
    else if (role === 'user' && Array.isArray(item.content)) {
      // Anthropic encodes tool results inside user messages. Preserve mixed user blocks.
      for (const block of item.content) {
        if (block?.type === 'tool_result') addResult(block, block.tool_use_id);
        else add('user', block);
      }
    } else add(role === 'assistant' ? 'assistant_history' : 'user', message);
  }
  const prefix = JSON.stringify({ tools: request.tools, system: request.system, systemMessages });
  return {
    version: 1,
    requestBytes: Buffer.byteLength(body),
    sections,
    toolResults: [...toolResults.values()],
    staticFingerprint: createHash('sha256').update(prefix).digest('hex'),
    // A breakpoint is configuration evidence only; actual cache hits come from usage.
    explicitCacheControls: (body.match(/"cache_control"\s*:/g) ?? []).length,
  };
}
