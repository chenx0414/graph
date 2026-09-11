import { DatabaseSync } from 'node:sqlite';

/** Disjoint token counts. Reasoning is part of output; cache subsets aren't added twice. */
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
type Account = { instance: string; budget: number; used: number; paused: number; hold: string | null };
type Call = { id: string; reserved: number; state: string; usage: string | null };

/** M0 single-owner broker. Callbacks are trusted dispatch code, never extension code. */
export class CallBroker {
  private readonly db: DatabaseSync;

  constructor(path: string, instanceId: string, budget = 20_000_000) {
    if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid budget');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS account (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        instance TEXT NOT NULL, budget INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, hold TEXT);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, reserved INTEGER NOT NULL,
        state TEXT NOT NULL, usage TEXT);`);
    this.db.prepare('INSERT OR IGNORE INTO account(singleton,instance,budget) VALUES(1,?,?)').run(instanceId, budget);
    const account = this.account();
    if (account.instance !== instanceId || account.budget !== budget) {
      this.db.close(); throw new Error('Persisted instance or budget mismatch');
    }
    this.transaction(() => {
      const result = this.db.prepare("UPDATE calls SET state='unknown' WHERE state='inflight'").run();
      if (result.changes) this.db.exec("UPDATE account SET hold='unknown usage after restart'");
    });
  }

  private account() { return this.db.prepare('SELECT * FROM account').get() as Account; }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** The gate check and actual send callback run in one JS turn without an await gap. */
  dispatch<T>(id: string, reservation: number, send: () => T): T {
    if (!id || !Number.isSafeInteger(reservation) || reservation < 0) throw new Error('Invalid call');
    this.transaction(() => {
      const account = this.account();
      if (account.paused) throw new Error('Instance paused');
      if (account.hold) throw new Error(account.hold);
      if (this.db.prepare('SELECT id FROM calls WHERE id=?').get(id)) throw new Error('Invocation already dispatched');
      const { reserved } = this.inspect();
      if (account.used + reserved + reservation > account.budget) throw new Error('Insufficient token budget');
      this.db.prepare("INSERT INTO calls VALUES(?,?,'inflight',NULL)").run(id, reservation);
    });
    try { return send(); }
    catch (error) { this.settle(id, null); throw error; }
  }

  settle(id: string, usage: TokenUsage | null) {
    const values = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    if (values && values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid usage');
    const total = values?.reduce((sum, value) => sum + value, 0);
    if (total !== undefined && !Number.isSafeInteger(total)) throw new Error('Invalid usage total');
    const serialized = usage ? JSON.stringify([usage.input, usage.output, usage.cacheRead, usage.cacheWrite]) : null;
    this.transaction(() => {
      const call = this.db.prepare('SELECT * FROM calls WHERE id=?').get(id) as Call | undefined;
      if (!call) throw new Error('Unknown invocation');
      if (call.state === 'complete') {
        if (call.usage !== serialized) throw new Error('Conflicting usage evidence');
        return;
      }
      if (usage === null) {
        this.db.prepare("UPDATE calls SET state='unknown' WHERE id=?").run(id);
        this.db.exec("UPDATE account SET hold='unknown usage'");
        return;
      }
      this.db.prepare("UPDATE calls SET state='complete', usage=?, reserved=0 WHERE id=?").run(serialized, id);
      this.db.prepare('UPDATE account SET used=used+?').run(total!);
      if (total! > call.reserved) this.db.exec("UPDATE account SET hold='usage exceeded reservation'");
    });
  }

  pause() { this.db.exec('UPDATE account SET paused=1'); }
  resume() { this.db.exec('UPDATE account SET paused=0'); }
  inspect() {
    const account = this.account();
    const calls = this.db.prepare('SELECT * FROM calls ORDER BY rowid').all() as Call[];
    const inflight = calls.filter(call => call.state === 'inflight').length;
    return {
      instanceId: account.instance, budget: account.budget, used: account.used,
      reserved: calls.reduce((sum, call) => sum + call.reserved, 0), hold: account.hold,
      status: account.paused ? (inflight ? 'pausing' : 'paused') : account.hold ? 'blocked' : 'ready',
      calls,
    };
  }
  close() { this.db.close(); }
}
