import { createHash } from 'node:crypto';

/** Host-wide in-flight scheduler for model requests.
 *
 * Slots are owned by credential ids and optional shared groups, so several
 * models, instances or tasks that resolve to the same credential cannot exceed
 * its cap, and aliases in one shared group share one counter. Waiting here
 * never holds a database transaction: the gate is re-checked by the caller
 * after the slot is granted, right before the provider send. */
export interface SlotRequest {
  credentialId: string;
  /** Actual key material, used only to derive an internal identity; never stored.
   * Aliases that resolve to the same key share one counter even if the caller
   * did not canonicalize their ids. */
  apiKey?: string;
  /** Per-credential cap. Undefined means unlimited. */
  limit?: number;
  sharedGroupId?: string;
  /** Shared group cap. Undefined means unlimited. */
  groupLimit?: number;
  /** Re-resolve the live request before every grant decision, so a queued
   * request picks up key rotation and limit changes from a hot config apply. */
  refresh?: () => SlotRequest;
}

export interface ModelScheduler {
  acquire(request: SlotRequest, signal?: AbortSignal): Promise<() => void>;
  /** Re-evaluate queued waiters after configuration changed. */
  wake(): void;
  /** Current in-flight count for one credential, or the total for all. */
  active(credentialId?: string): number;
  queued(): number;
  /** Backend facts for waiting-state displays: busy and waiting per credential. */
  snapshot(): { active: Record<string, number>; queued: Record<string, number> };
}

interface Waiter {
  request: SlotRequest;
  resolve(release: () => void): void;
  reject(error: Error): void;
  done: boolean;
}

function aborted() {
  const error = new Error('Model slot wait aborted');
  error.name = 'AbortError';
  return error;
}

export function createModelScheduler(): ModelScheduler {
  const waiters: Waiter[] = [];
  const activeByCredential = new Map<string, number>();
  const activeByGroup = new Map<string, number>();
  const canonicalByKey = new Map<string, string>();

  /** Same actual key under different alias ids shares one accounting identity. */
  const identityOf = (request: SlotRequest) => {
    if (!request.apiKey) return request.credentialId;
    const fingerprint = createHash('sha256').update(request.apiKey).digest('hex');
    const existing = canonicalByKey.get(fingerprint);
    if (existing) return existing;
    canonicalByKey.set(fingerprint, request.credentialId);
    return request.credentialId;
  };

  const current = (waiter: Waiter) => waiter.request.refresh?.() ?? waiter.request;

  const runnable = (waiter: Waiter) => {
    const request = current(waiter);
    return (activeByCredential.get(identityOf(request)) ?? 0) < (request.limit ?? Infinity) &&
      (!request.sharedGroupId || (activeByGroup.get(request.sharedGroupId) ?? 0) < (request.groupLimit ?? Infinity));
  };

  function grant(waiter: Waiter) {
    const request = current(waiter);
    const credentialId = identityOf(request);
    const { sharedGroupId } = request;
    activeByCredential.set(credentialId, (activeByCredential.get(credentialId) ?? 0) + 1);
    if (sharedGroupId) activeByGroup.set(sharedGroupId, (activeByGroup.get(sharedGroupId) ?? 0) + 1);
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      const remaining = (activeByCredential.get(credentialId) ?? 1) - 1;
      if (remaining > 0) activeByCredential.set(credentialId, remaining);
      else activeByCredential.delete(credentialId);
      if (sharedGroupId) {
        const groupRemaining = (activeByGroup.get(sharedGroupId) ?? 1) - 1;
        if (groupRemaining > 0) activeByGroup.set(sharedGroupId, groupRemaining);
        else activeByGroup.delete(sharedGroupId);
      }
      drain();
    });
  }

  function drain() {
    // Scan in arrival order and start every runnable waiter, so a waiter blocked
    // on one full credential cannot starve later waiters on another.
    for (const waiter of [...waiters]) {
      if (waiter.done || !runnable(waiter)) continue;
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      waiter.done = true;
      grant(waiter);
    }
  }

  return {
    acquire(request, signal) {
      if (signal?.aborted) return Promise.reject(aborted());
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = { request, done: false, resolve, reject };
        const onAbort = () => {
          if (waiter.done) return;
          waiter.done = true;
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(aborted());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        drain();
        // Granting happens synchronously inside drain; when it did, the abort
        // listener must not remain attached to the caller's signal.
        if (waiter.done) signal?.removeEventListener('abort', onAbort);
      });
    },
    active(credentialId) {
      if (credentialId) return activeByCredential.get(credentialId) ?? 0;
      let total = 0;
      for (const count of activeByCredential.values()) total += count;
      return total;
    },
    queued() {
      return waiters.filter(waiter => !waiter.done).length;
    },
    wake() {
      drain();
    },
    snapshot() {
      const active: Record<string, number> = {};
      for (const [id, count] of activeByCredential) active[id] = count;
      const queued: Record<string, number> = {};
      for (const waiter of waiters) {
        if (waiter.done) continue;
        const identity = identityOf(current(waiter));
        queued[identity] = (queued[identity] ?? 0) + 1;
      }
      return { active, queued };
    },
  };
}
