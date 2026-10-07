import type { TaskStore } from './store.ts';

/** Release a confirmed task's integration slot only after its work has ended.
 * The caller's transaction keeps the terminal state and successor admission atomic.
 * Management-created graphs that never owned this slot cannot release another task.
 */
export function releaseTaskSlot(store: TaskStore, taskId: string): string | null {
  const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
  if (active_task !== taskId) return null;
  const next = store.db.prepare("SELECT id FROM tasks WHERE phase='queued' ORDER BY created_seq LIMIT 1").get() as { id: string } | undefined;
  store.db.prepare('UPDATE runtime SET active_task=?').run(next?.id ?? null);
  if (!next) return null;
  store.db.prepare("UPDATE tasks SET phase='running' WHERE id=?").run(next.id);
  store.event(next.id, 'task.started', {});
  return next.id;
}
