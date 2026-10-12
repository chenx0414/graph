import { realpath } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { StorageRejected, type Storage } from '@earendil-works/pi-durable';
import type { TaskStore } from '../core/store.ts';

const owners = new Set<string>();
const methods = new Set(['commit', 'mintId', 'conversation', 'scanConversations', 'entry', 'findLatestHeadMarker', 'scanEntries', 'task', 'scanTasks', 'submission', 'scanSubmissions', 'submissionByRequest', 'findDocument', 'document', 'scanDocuments', 'close']);

/** All durable transactions execute off the Graph thread, on the same SQLite
 * file. A bounded SQLite lock wait cannot block the worker that must release it.
 * Closing storage closes only the worker's connection, never TaskStore's. */
export async function openDurableStorage(store: TaskStore): Promise<Storage> {
  if (store.path === ':memory:') throw new Error('Durable execution requires a disk-backed Graph store');
  const path = await realpath(store.path);
  if (owners.has(path)) throw new Error('A durable storage owner is already open for this Graph database');
  owners.add(path);
  let worker: Worker;
  try {
    store.db.exec('PRAGMA busy_timeout = 5000');
    worker = new Worker(new URL('./durable-storage-worker.ts', import.meta.url), { workerData: { path }, execArgv: [] });
  } catch (error) { owners.delete(path); throw error; }
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  let closed = false;
  let failure: Error | undefined;
  const fail = (error: Error) => { failure = error; for (const request of pending.values()) request.reject(error); pending.clear(); };
  const ready = Promise.withResolvers<void>();
  worker.on('message', (message: { ready?: boolean; fatal?: string; id?: number; value?: unknown; error?: { message: string; name?: string } }) => {
    if (message.ready) { ready.resolve(); return; }
    if (message.fatal) { const error = new Error(message.fatal); ready.reject(error); fail(error); return; }
    const request = message.id === undefined ? undefined : pending.get(message.id);
    if (!request || message.id === undefined) return;
    pending.delete(message.id);
    if (message.error) request.reject(message.error.name === 'StorageRejected' ? new StorageRejected(message.error.message) : Object.assign(new Error(message.error.message), { name: message.error.name ?? 'Error' }));
    else request.resolve(message.value);
  });
  worker.on('error', error => { ready.reject(error); fail(error); });
  worker.on('exit', () => { owners.delete(path); if (!closed) { const error = new Error('Durable storage worker exited'); ready.reject(error); fail(error); } });
  try { await ready.promise; }
  catch (error) { await worker.terminate(); owners.delete(path); throw error; }
  const invoke = async (method: string, args: unknown[]) => {
    if (closed) throw new Error('Durable storage is closed');
    if (failure) throw failure;
    const id = ++sequence;
    const result = Promise.withResolvers<unknown>();
    pending.set(id, result);
    try { worker.postMessage({ id, method, args: method === 'mintId' ? [] : args.slice(0, -1) }); }
    catch (error) { pending.delete(id); result.reject(error); }
    return result.promise;
  };
  // Storage is a fixed method-only RPC protocol; numeric branded IDs and JSON
  // records preserve their values through structured clone.
  return new Proxy({} as Storage, {
    get: (_target, key) => {
      if (typeof key !== 'string' || !methods.has(key)) return undefined;
      if (key === 'close') return async (...args: unknown[]) => {
        if (closed) return;
        try { await invoke('close', args); }
        finally { closed = true; await worker.terminate(); owners.delete(path); }
      };
      return (...args: unknown[]) => invoke(key, args);
    },
  });
}
