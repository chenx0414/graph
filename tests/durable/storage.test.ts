import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { TaskStore } from '../../src/core/store.ts';
import { openDurableStorage } from '../../src/runtime/durable-storage.ts';

registerStorageConformance({ describe, expect, it }, 'same-file Graph durable storage contract', async use => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-storage-'));
  const store = new TaskStore(join(root, 'state.sqlite'));
  const storage = await openDurableStorage(store);
  try { await use(storage); }
  finally { await storage.close(BACKGROUND_CONTEXT); store.close(); await rm(root, { recursive: true, force: true }); }
});

it('allows only one durable owner even when the formal database is opened through a symbolic-link alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-owner-'));
  const store = new TaskStore(join(root, 'state.sqlite'));
  const { symlink } = await import('node:fs/promises');
  await symlink(store.path, join(root, 'alias.sqlite'));
  const alias = new TaskStore(join(root, 'alias.sqlite'));
  const storage = await openDurableStorage(store);
  let duplicate: Awaited<ReturnType<typeof openDurableStorage>> | undefined;
  try {
    await expect((async () => { duplicate = await openDurableStorage(alias); })()).rejects.toThrow('already open');
  } finally {
    await duplicate?.close(BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    alias.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

it('keeps Graph commands committed when an overlapping durable batch rolls back, and closes only the worker connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-coexist-'));
  const store = new TaskStore(join(root, 'state.sqlite'));
  const storage = await openDurableStorage(store);
  const { setImmediate } = await import('node:timers/promises');
  const { StorageRejected } = await import('@earendil-works/pi-durable');
  type ConversationId = import('@earendil-works/pi-durable').ConversationId;
  type DocumentId = import('@earendil-works/pi-durable').DocumentId;
  try {
    const conversations = await Promise.all(Array.from({ length: 2_000 }, async () => ({ id: await storage.mintId<ConversationId>() })));
    const copy = await storage.mintId<DocumentId>();
    const missing = await storage.mintId<DocumentId>();
    const failing = storage.commit([
      ...conversations.map(value => ({ type: 'conversation' as const, value })),
      { type: 'document.copy', record: { id: copy, kind: 'missing-source', scope: { kind: 'conversation', conversationId: conversations[0]!.id }, history: 'latest', fork: 'current' }, source: { id: missing, at: 'current' } },
    ], BACKGROUND_CONTEXT).catch(error => error);
    await setImmediate();
    const receipt = store.command('coexist', 'domain-write', { text: 'keep Graph domain fact' }, () => {
      store.event(null, 'coexist.test', { text: 'keep Graph domain fact' });
      return { accepted: true };
    });
    expect(await failing).toBeInstanceOf(StorageRejected);
    expect((await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
    expect(store.command('coexist', 'domain-write', { text: 'keep Graph domain fact' }, () => { throw new Error('Committed receipt was lost'); })).toEqual(receipt);
    await storage.close(BACKGROUND_CONTEXT);
    expect(store.command('coexist', 'after-close', {}, () => ({ usable: true }))).toEqual({ usable: true });
  } finally { await storage.close(BACKGROUND_CONTEXT); store.close(); await rm(root, { recursive: true, force: true }); }
});

it('namespaces SQL identifiers while preserving literals, quoted text and comments, and rolls back the entire adapter transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-sql-'));
  const store = new TaskStore(join(root, 'state.sqlite'));
  const { openNodeSqliteDatabase } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const { namespaceDurableDatabase } = await import('../../src/runtime/durable-sqlite.ts');
  const sql = namespaceDurableDatabase(await openNodeSqliteDatabase(store.path));
  try {
    await sql.exec('CREATE TABLE "tasks" (id INTEGER PRIMARY KEY, value TEXT)');
    await sql.run("INSERT INTO [tasks] VALUES (?, 'tasks -- conversations /* entries */')", 1);
    expect(await sql.get('SELECT value, \'tasks\' AS literal, \'it\'\'s tasks\' AS escaped FROM `tasks` -- tasks\n /* entries */ WHERE id = ?', 1))
      .toEqual({ value: 'tasks -- conversations /* entries */', literal: 'tasks', escaped: "it's tasks" });
    await expect(sql.transaction(async tx => {
      await tx.run('INSERT INTO tasks VALUES(?,?)', 2, 'rollback');
      await tx.run('INSERT INTO tasks VALUES(?,?)', 1, 'duplicate');
    })).rejects.toThrow();
    expect(await sql.all('SELECT id FROM tasks ORDER BY id')).toEqual([{ id: 1 }]);
    // The Graph domain's original tasks table remains independent.
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toMatchObject({ count: 0 });
    await sql.close();
    expect(store.command('sql-owner', 'alive', {}, () => 'host remains open')).toBe('host remains open');
  } finally { await sql.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
