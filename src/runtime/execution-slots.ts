import type { TaskStore } from '../core/store.ts';
import { clearOperationCredentialWait } from '../core/operation-lifecycle.ts';

/** Local execution capacity. Credential waits are not execution work: an
 * operation parked on a credential slot sets waiting_slot=1 and stops counting
 * here; when its credential slot is granted it must take an execution slot
 * back before it may send. */
export const AGENT_EXECUTION_LIMIT = 10;
export const PROGRAM_EXECUTION_LIMIT = 4;

export function executionLimit(kind: 'agent' | 'program') {
  return kind === 'agent' ? AGENT_EXECUTION_LIMIT : PROGRAM_EXECUTION_LIMIT;
}

export function occupiedSlots(store: TaskStore, kind: 'agent' | 'program') {
  const { occupied } = store.db.prepare(`SELECT COUNT(*) AS occupied FROM operations
    WHERE (state='intent' OR (worker_active=1 AND waiting_slot=0)) AND (instance_id IS NOT NULL)=?`).get(Number(kind === 'agent')) as { occupied: number };
  return occupied;
}

function aborted() {
  const error = new Error('Execution slot wait aborted');
  error.name = 'AbortError';
  return error;
}

/** Atomically take an Agent execution slot after a credential wait. */
export async function waitForAgentExecutionSlot(store: TaskStore, operationId: string, signal?: AbortSignal) {
  for (;;) {
    if (signal?.aborted) throw aborted();
    const admitted = store.transaction(() => {
      if (occupiedSlots(store, 'agent') >= AGENT_EXECUTION_LIMIT) return false;
      clearOperationCredentialWait(store, operationId);
      return true;
    });
    if (admitted) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
