import { DatabaseSync } from 'node:sqlite';
import { RuntimeError } from './types.ts';

/** A separate rollback-journal DB holds an OS lock for the owner's entire lifetime.
 * No heartbeat timeout can steal a live daemon; process death releases the lock. */
export function acquireOwner(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) throw new RuntimeError('owner_busy', 'Another daemon owns this state directory');
    throw error;
  }
  let released = false;
  return () => { if (!released) { released = true; db.exec('ROLLBACK'); db.close(); } };
}
