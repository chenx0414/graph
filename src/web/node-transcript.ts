import type { ConversationMessage } from '../core/conversation-projection.ts';
export interface Entry { seq: number; id: string; role: string; kind: string; text: string; data: Record<string, unknown> | null; operationId: string | null; createdAt: number }

/** Session assistant messages include intermediate narration. Only the last
 * assistant record of a settled operation is its final answer. */
export function nodeMessages(entries: Entry[], operations: { id: string; state: string; workerActive?: boolean }[], busy: boolean): ConversationMessage[] {
  let legacyTurn = 0;
  entries = entries.map(entry => {
    if (!entry.operationId && entry.role === 'user') legacyTurn++;
    return { ...entry, operationId: entry.operationId ?? `legacy:${legacyTurn}` };
  });
  const last = new Map<string, Entry>();
  for (const entry of entries) if (entry.operationId && entry.role === 'assistant') last.set(entry.operationId, entry);
  const active = new Set(operations.filter(operation => operation.workerActive || ['prepared', 'dispatched', 'running'].includes(operation.state)).map(operation => operation.id));
  const newest = entries.at(-1)?.operationId;
  return entries.map(entry => {
    const operationId = entry.operationId ?? `legacy:${entry.id}`;
    const final = entry.role === 'assistant' && last.get(operationId)?.id === entry.id
      && !active.has(operationId) && !(busy && !operations.length && entry.operationId === newest);
    return {
      id: entry.id, seq: entry.seq,
      role: entry.role === 'assistant' && !final ? 'activity' : entry.role,
      kind: entry.role === 'assistant' ? final ? 'chat' : 'activity' : entry.kind,
      text: entry.text, data: entry.data,
      state: entry.role === 'tool' && entry.kind === 'call' ? 'pending' : 'done',
      operationId, turn: 0, createdAt: entry.createdAt, updatedAt: entry.createdAt,
    };
  });
}
