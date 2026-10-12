import { parentPort, workerData } from 'node:worker_threads';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { namespaceDurableDatabase } from './durable-sqlite.ts';

const port = parentPort!;
try {
  const database = await openNodeSqliteDatabase(workerData.path);
  await database.exec('PRAGMA synchronous = FULL');
  const storage = await SqliteStorage.open(namespaceDurableDatabase(database));
  port.on('message', (message: { id: number; method: keyof typeof storage; args: unknown[] }) => {
    void (async () => {
      try {
        // RPC exposes the Storage contract only. Contexts remain thread-local.
        const method = storage[message.method];
        if (typeof method !== 'function') throw new Error('Unknown durable storage operation');
        const args = message.method === 'mintId' ? [] : [...message.args, BACKGROUND_CONTEXT];
        const value = await Reflect.apply(method, storage, args);
        port.postMessage({ id: message.id, value });
      } catch (error) {
        port.postMessage({ id: message.id, error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) } });
      }
    })();
  });
  port.postMessage({ ready: true });
} catch (error) {
  port.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
  port.close();
}
