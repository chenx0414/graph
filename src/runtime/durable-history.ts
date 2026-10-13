import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSessionContext, convertToLlm, parseSessionEntries } from '@earendil-works/pi-coding-agent';
import type { ConversationId, Tx } from '@earendil-works/pi-durable';
import type { AgentSessionRequest } from './agent-session.ts';

/** Import a validated legacy source passively. The original bytes and branch
 * records stay archived; only the active branch reaches future model requests. */
export async function legacyHistory(request: Pick<AgentSessionRequest, 'binding' | 'stateDir'>): Promise<((tx: Tx, id: ConversationId) => Promise<void>) | undefined> {
  let manifest: { binding: { instanceId: string; nodeId: string }; sessionId: string; sessionFile: string };
  try { manifest = JSON.parse(await readFile(join(request.stateDir, 'instance.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (manifest.binding.instanceId !== request.binding.instanceId || manifest.binding.nodeId !== request.binding.nodeId) throw new Error('Legacy history belongs to a different agent identity');
  const raw = await readFile(manifest.sessionFile, 'utf8');
  const lines = raw.split('\n').filter(line => line.trim());
  const records = lines.map(line => JSON.parse(line) as { type: string; id: string; parentId?: string | null });
  if (records[0]?.type !== 'session' || records[0].id !== manifest.sessionId) throw new Error('Legacy history session identity does not match its manifest');
  if (records.slice(1).some(record => !record.id || typeof record.type !== 'string')) throw new Error('Legacy history contains an invalid session entry');
  const entries = parseSessionEntries(raw).filter(entry => entry.type !== 'session');
  const leafId = entries.at(-1)?.id ?? null;
  const context = buildSessionContext(entries, leafId);
  const messages = convertToLlm(context.messages);
  const digest = createHash('sha256').update(raw).digest('hex');
  const backupDir = join(request.stateDir, 'durable-history');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `${digest}.jsonl`);
  try { await writeFile(backup, raw, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (await readFile(backup, 'utf8') !== raw) throw new Error('Legacy history archive digest mismatch'); }
  return async (tx, id) => {
    await tx.appendEntry(id, { kind: 'graph.legacy-history', data: { sessionId: manifest.sessionId, source: manifest.sessionFile, backup, digest, leafId, records: JSON.parse(JSON.stringify(records)) } });
    for (const [index, message] of messages.entries()) await tx.appendEntry(id, { kind: 'graph.imported-history', model: [message], data: { sourceDigest: digest, activeContextIndex: index } });
  };
}
