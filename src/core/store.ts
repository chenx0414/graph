import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { RuntimeError } from './types.ts';

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === 'object' && item) {
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, normalize((item as Record<string, unknown>)[key])]));
    }
    throw new RuntimeError('invalid_input', 'Expected JSON data');
  };
  return JSON.stringify(normalize(value));
}

export interface TaskRow {
  id: string; project_id: string; request: string; requirement_version: number;
  latest_proposal: number; accepted_proposal: number | null; target_branch: string | null;
  phase: string; paused: number; created_seq: number; graph_version: number;
  integration_branch: string | null; integration_sha: string | null; target_sha: string | null;
  conversation_id: string | null; decision_digest: string | null;
}

/** SQLite and transaction details stay private to the Task Runtime module. */
export class TaskStore {
  readonly db: DatabaseSync;
  private readonly changes = new EventEmitter();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 18) { this.db.close(); throw new RuntimeError('schema_version', 'Database belongs to a newer runtime'); }
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY, root TEXT NOT NULL, grants TEXT NOT NULL);
        CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request TEXT NOT NULL,
          requirement_version INTEGER NOT NULL DEFAULT 1, latest_proposal INTEGER NOT NULL DEFAULT 0,
          accepted_proposal INTEGER, target_branch TEXT, phase TEXT NOT NULL DEFAULT 'discussing',
          paused INTEGER NOT NULL DEFAULT 0, created_seq INTEGER NOT NULL);
        CREATE TABLE proposals(task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
          requirement_version INTEGER NOT NULL, spec TEXT NOT NULL, PRIMARY KEY(task_id,version));
        CREATE TABLE nodes(task_id TEXT NOT NULL REFERENCES tasks(id), id TEXT NOT NULL, spec TEXT NOT NULL,
          instance_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(task_id,id));
        CREATE TABLE instances(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
          budget INTEGER NOT NULL DEFAULT 20000000, used INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(task_id,node_id) REFERENCES nodes(task_id,id), UNIQUE(task_id,node_id));
        CREATE TABLE commands(scope TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL,
          PRIMARY KEY(scope,request_id));
        CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
          type TEXT NOT NULL, data TEXT NOT NULL, timestamp INTEGER NOT NULL);
        CREATE TABLE runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1), active_task TEXT REFERENCES tasks(id), generation INTEGER NOT NULL DEFAULT 0);
        INSERT INTO runtime(singleton) VALUES(1);
        PRAGMA user_version=1;
      `);
    });
    if (version < 2) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN output TEXT;
        CREATE TABLE operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
          instance_id TEXT REFERENCES instances(id), generation INTEGER NOT NULL, spec TEXT NOT NULL,
          state TEXT NOT NULL, reserved INTEGER NOT NULL, worker_active INTEGER NOT NULL DEFAULT 0,
          result TEXT, usage TEXT, FOREIGN KEY(task_id,node_id) REFERENCES nodes(task_id,id));
        CREATE TABLE evidence(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          node_id TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES operations(id),
          acceptance_id TEXT NOT NULL, proposal_version INTEGER NOT NULL, requirement_version INTEGER NOT NULL,
          data TEXT NOT NULL, UNIQUE(operation_id,acceptance_id));
        PRAGMA user_version=2;
      `);
    });
    if (version < 3) this.transaction(() => {
      this.db.exec(`CREATE TABLE questions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        node_id TEXT NOT NULL, operation_id TEXT REFERENCES operations(id), kind TEXT NOT NULL,
        data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', answer TEXT);
        PRAGMA user_version=3;`);
    });
    if (version < 4) this.transaction(() => {
      this.db.exec(`CREATE TABLE task_grants(task_id TEXT NOT NULL REFERENCES tasks(id), grant TEXT NOT NULL,
        PRIMARY KEY(task_id,grant)); PRAGMA user_version=4;`);
    });
    if (version < 5) this.transaction(() => { this.db.exec('ALTER TABLE nodes ADD COLUMN route TEXT; PRAGMA user_version=5;'); });
    if (version < 6) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN graph_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE nodes ADD COLUMN activation_id TEXT;
        ALTER TABLE nodes ADD COLUMN output_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE nodes ADD COLUMN output_operation TEXT REFERENCES operations(id);
        ALTER TABLE operations ADD COLUMN activation_id TEXT;
        ALTER TABLE evidence ADD COLUMN activation_id TEXT;
        ALTER TABLE evidence ADD COLUMN valid INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE graph_revisions(task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
          spec TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(task_id,version));
        CREATE TABLE activations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
          graph_version INTEGER NOT NULL, round INTEGER NOT NULL, state TEXT NOT NULL, input_versions TEXT NOT NULL,
          FOREIGN KEY(task_id,node_id) REFERENCES nodes(task_id,id));
        INSERT INTO graph_revisions SELECT t.id,1,p.spec,'M1 confirmation' FROM tasks t JOIN proposals p
          ON p.task_id=t.id AND p.version=t.accepted_proposal;
        UPDATE tasks SET graph_version=1 WHERE accepted_proposal IS NOT NULL;
        INSERT INTO activations SELECT lower(hex(randomblob(16))),task_id,id,1,1,status,'{}' FROM nodes;
        UPDATE nodes SET activation_id=(SELECT a.id FROM activations a WHERE a.task_id=nodes.task_id AND a.node_id=nodes.id),
          output_operation=(SELECT o.id FROM operations o WHERE o.task_id=nodes.task_id AND o.node_id=nodes.id AND o.state='succeeded' ORDER BY o.rowid DESC LIMIT 1),
          output_version=(SELECT COUNT(*) FROM operations o WHERE o.task_id=nodes.task_id AND o.node_id=nodes.id AND o.state='succeeded');
        UPDATE operations SET activation_id=(SELECT n.activation_id FROM nodes n WHERE n.task_id=operations.task_id AND n.id=operations.node_id);
        UPDATE operations SET spec=json_set(spec,'$.activationId',activation_id,'$.graphVersion',1,'$.dependencySources',json('{}'),'$.inputVersions',json('{}'));
        UPDATE evidence SET activation_id=(SELECT o.activation_id FROM operations o WHERE o.id=evidence.operation_id);
        PRAGMA user_version=6;
      `);
    });
    if (version < 7) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN stall_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE graph_revisions ADD COLUMN base_version INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=7;
      `);
    });
    if (version < 8) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE instances ADD COLUMN definition_version TEXT;
        ALTER TABLE instances ADD COLUMN model TEXT;
        ALTER TABLE instances ADD COLUMN models_used TEXT NOT NULL DEFAULT '[]';
        CREATE TABLE definitions(id TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE capabilities(id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, version TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE installations(id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, state TEXT NOT NULL, spec TEXT NOT NULL, result TEXT);
        CREATE TABLE invocations(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, instance_id TEXT NOT NULL, model TEXT NOT NULL, usage TEXT, cost TEXT);
        CREATE TABLE models(id TEXT PRIMARY KEY, spec TEXT NOT NULL);
        PRAGMA user_version=8;
      `);
    });
    if (version < 9) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN integration_branch TEXT;
        ALTER TABLE tasks ADD COLUMN integration_sha TEXT;
        ALTER TABLE tasks ADD COLUMN target_sha TEXT;
        ALTER TABLE evidence ADD COLUMN commit_sha TEXT;
        CREATE TABLE worktrees(instance_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL);
        CREATE TABLE git_ops(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, spec TEXT NOT NULL, result TEXT);
        CREATE TABLE git_commits(sha TEXT NOT NULL, task_id TEXT NOT NULL, node_id TEXT, operation_id TEXT, kind TEXT NOT NULL);
        PRAGMA user_version=9;
      `);
    });
    if (version < 10) this.transaction(() => {
      // Operations waiting for a credential slot must not consume execution slots.
      this.db.exec('ALTER TABLE operations ADD COLUMN waiting_slot INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=10;');
    });
    if (version < 11) this.transaction(() => {
      // Conversations own a durable master message log; their anchor task keeps
      // every master turn inside the existing operation/instance ledger.
      this.db.exec(`
        CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT,
          workspace_project_id TEXT NOT NULL, anchor_task_id TEXT NOT NULL, title TEXT NOT NULL,
          created_seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, kind TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '', data TEXT, state TEXT NOT NULL, operation_id TEXT,
          turn INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX messages_scope ON messages(conversation_id, seq);
        ALTER TABLE tasks ADD COLUMN conversation_id TEXT;
        CREATE TABLE conversation_acceptances(conversation_id TEXT NOT NULL REFERENCES conversations(id),
          proposal_version INTEGER NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
          target_branch TEXT NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,proposal_version));
        PRAGMA user_version=11;`);
    });
    if (version < 12) this.transaction(() => {
      // Conversation decisions/constraints travel to the feature task so
      // sub-agents inherit the confirmed context, not only the proposal.
      this.db.exec('ALTER TABLE tasks ADD COLUMN decision_digest TEXT; PRAGMA user_version=12;');
    });
    if (version < 13) this.transaction(() => {
      // The decision snapshot is frozen when a draft is proposed (bound to the
      // project binding and to the messages the master actually consumed), so
      // confirmation passes exactly what the user reviewed.
      this.db.exec(`
        ALTER TABLE proposals ADD COLUMN decision_snapshot TEXT;
        ALTER TABLE conversations ADD COLUMN binding_since_seq INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=13;`);
    });
    if (version < 14) this.transaction(() => {
      // New instances default to no cumulative token cap (unlimited=1). Every
      // existing instance keeps its finite budget and used total untouched;
      // migration never rewrites an old row into unlimited.
      this.db.exec('ALTER TABLE instances ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=14;');
    });
    if (version < 15) this.transaction(() => {
      // Business projects must be Git-ready before formal dispatch; this row
      // records detection/initialization, the baseline commit and scope.
      this.db.exec(`
        CREATE TABLE project_preparation(project_id TEXT PRIMARY KEY REFERENCES projects(id),
          state TEXT NOT NULL, repo_root TEXT, project_subdir TEXT, branch TEXT, baseline_sha TEXT,
          detail TEXT, updated_at INTEGER NOT NULL);
        PRAGMA user_version=15;`);
    });
    if (version < 16) this.transaction(() => {
      // Built-in preset installations are recorded by content hash so a normal
      // restart never republishes a new version of an unchanged preset.
      this.db.exec(`
        CREATE TABLE presets(id TEXT PRIMARY KEY, version TEXT NOT NULL, hash TEXT NOT NULL,
          detail TEXT, installed_at INTEGER NOT NULL);
        PRAGMA user_version=16;`);
    });
    if (version < 17) this.transaction(() => {
      // Node detail projection: real Pi session entries per node plus timing
      // facts that keep credential-slot waiting out of the run duration.
      this.db.exec(`
        CREATE TABLE node_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL, node_id TEXT NOT NULL, instance_id TEXT, activation_id TEXT, operation_id TEXT,
          role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', data TEXT,
          created_at INTEGER NOT NULL);
        CREATE INDEX node_entries_scope ON node_entries(task_id,node_id,seq);
        CREATE TABLE node_sessions(instance_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
          session_file TEXT, updated_at INTEGER NOT NULL);
        ALTER TABLE operations ADD COLUMN dispatched_at INTEGER;
        ALTER TABLE operations ADD COLUMN settled_at INTEGER;
        ALTER TABLE operations ADD COLUMN waiting_since INTEGER;
        ALTER TABLE operations ADD COLUMN waiting_ms INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=17;`);
    });
    if (version < 18) this.transaction(() => {
      // Capability loading facts per operation: what was actually loaded and
      // executable at that time, so later install/config changes never rewrite
      // a historical node's projection.
      this.db.exec(`
        CREATE TABLE node_capabilities(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          node_id TEXT NOT NULL, instance_id TEXT, operation_id TEXT, read_only INTEGER NOT NULL,
          loaded TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX node_capabilities_scope ON node_capabilities(task_id,node_id,seq);
        PRAGMA user_version=18;`);
    });
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try { result = action(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.changes.emit('change'); return result;
  }
  command<T>(scope: string, requestId: string, payload: unknown, apply: () => T): T {
    if (!requestId || requestId.length > 200) throw new RuntimeError('invalid_input', 'A bounded requestId is required');
    const encoded = canonicalJson(payload);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?').get(scope, requestId) as { payload: string; receipt: string } | undefined;
      if (previous) {
        if (previous.payload !== encoded) throw new RuntimeError('idempotency_conflict', 'requestId was already used with different content');
        return JSON.parse(previous.receipt) as T;
      }
      const result = apply();
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(scope, requestId, encoded, canonicalJson(result));
      return result;
    });
  }
  event(taskId: string | null, type: string, data: unknown) {
    const cursor = Number(this.db.prepare('INSERT INTO events(task_id,type,data,timestamp) VALUES(?,?,?,?)')
      .run(taskId, type, canonicalJson(data), Date.now()).lastInsertRowid);
    // Some writers record events outside a transaction; wake stream watchers
    // here so live delivery cannot depend on an unrelated commit.
    this.changes.emit('change');
    return cursor;
  }
  task(id: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
    if (!row) throw new RuntimeError('not_found', 'Task not found');
    return row;
  }
  waitForChange(signal: AbortSignal) {
    let finish!: () => void;
    const promise = new Promise<void>(resolve => {
      finish = () => { this.changes.off('change', finish); signal.removeEventListener('abort', finish); resolve(); };
      this.changes.once('change', finish);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    return { promise, cancel: finish };
  }
  close() { this.db.close(); this.changes.emit('change'); }
}
