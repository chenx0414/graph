import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { RuntimeError } from './types.ts';

/** Latest schema version this runtime writes. The startup guard and every version
 * assertion refer to it, so adding a migration is one edit instead of five — a
 * mismatch here once rejected the database the same process had just created. */
export const SCHEMA_VERSION = 38;

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
  /** Where this store lives: the state directory's own layout (instances/, rsi/) hangs off it. */
  readonly path: string;
  private readonly changes = new EventEmitter();
  private readonly eventListeners = new Set<(type: string) => void>();
  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) { this.db.close(); throw new RuntimeError('schema_version', 'Database belongs to a newer runtime'); }
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
    if (version < 19) this.transaction(() => {
      // Pause / user-wait time ledger on the node (C02). NULL columns mean the
      // segment was never recorded, so history keeps showing "未记录".
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN pause_ms INTEGER;
        ALTER TABLE nodes ADD COLUMN pause_since INTEGER;
        ALTER TABLE nodes ADD COLUMN user_wait_ms INTEGER;
        ALTER TABLE nodes ADD COLUMN user_wait_since INTEGER;
        PRAGMA user_version=19;`);
    });
    if (version < 20) this.transaction(() => {
      // Every provider send is an invocation; Pi context summarization is not
      // a free side effect and must be attributable in the ledger.
      this.db.exec(`
        ALTER TABLE invocations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'completion';
        PRAGMA user_version=20;`);
    });
    if (version < 21) this.transaction(() => {
      // Conversation-level presentation state stays with the conversation, not
      // with a particular master operation. Archived rows remain readable and
      // can be restored without deleting messages or task history.
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
        ALTER TABLE conversations ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off';
        CREATE INDEX conversations_archived ON conversations(archived_at);
        PRAGMA user_version=21;`);
    });
    if (version < 22) this.transaction(() => {
      // Agent context lineage is first-class: continue, snapshot fork and
      // fresh handoff all share one durable budget/audit model.
      this.db.exec(`
        CREATE TABLE budget_scopes(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          owner_instance_id TEXT REFERENCES instances(id), limit_tokens INTEGER, unlimited INTEGER NOT NULL,
          used_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        CREATE INDEX budget_scopes_task ON budget_scopes(task_id);
      `);
      const columns = new Set((this.db.prepare('PRAGMA table_info(instances)').all() as { name: string }[]).map(row => row.name));
      if (!columns.has('budget_scope_id')) this.db.exec('ALTER TABLE instances ADD COLUMN budget_scope_id TEXT REFERENCES budget_scopes(id);');
      if (!columns.has('parent_instance_id')) this.db.exec('ALTER TABLE instances ADD COLUMN parent_instance_id TEXT REFERENCES instances(id);');
      this.db.exec(`
        INSERT INTO budget_scopes(id,task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at)
          SELECT lower(hex(randomblob(16))),task_id,id,CASE WHEN unlimited=1 THEN NULL ELSE budget END,unlimited,used,0 FROM instances;
        UPDATE instances SET budget_scope_id=(SELECT id FROM budget_scopes s WHERE s.owner_instance_id=instances.id);
        CREATE TABLE context_handoffs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          operation_id TEXT REFERENCES operations(id), version INTEGER NOT NULL, purpose TEXT NOT NULL,
          summary TEXT NOT NULL, package TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX context_handoffs_task ON context_handoffs(task_id,created_at);
        CREATE TABLE agent_context_bindings(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          node_id TEXT NOT NULL, instance_id TEXT NOT NULL UNIQUE REFERENCES instances(id),
          mode TEXT NOT NULL CHECK(mode IN ('fresh','fork')), source_instance_id TEXT REFERENCES instances(id),
          source_session_id TEXT, source_session_file TEXT, source_leaf_id TEXT, source_context_digest TEXT,
          child_context_digest TEXT, handoff_id TEXT REFERENCES context_handoffs(id), capability_digest TEXT,
          budget_scope_id TEXT NOT NULL REFERENCES budget_scopes(id), created_at INTEGER NOT NULL);
        CREATE INDEX agent_context_bindings_task ON agent_context_bindings(task_id,node_id);
        CREATE TABLE context_resolutions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          node_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
          requested_purpose TEXT NOT NULL, requested_facts TEXT NOT NULL DEFAULT '[]', independence TEXT NOT NULL,
          selected_mode TEXT NOT NULL CHECK(selected_mode IN ('continue','fresh','fork')),
          reason_code TEXT NOT NULL, source_instance_id TEXT REFERENCES instances(id),
          binding_id TEXT NOT NULL REFERENCES agent_context_bindings(id), handoff_id TEXT NOT NULL REFERENCES context_handoffs(id),
          created_at INTEGER NOT NULL);
        CREATE INDEX context_resolutions_binding ON context_resolutions(binding_id,created_at);
        INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,budget_scope_id,created_at)
          SELECT lower(hex(randomblob(16))),i.task_id,i.node_id,i.id,'fresh',i.budget_scope_id,0
          FROM instances i JOIN node_sessions s ON s.instance_id=i.id
          WHERE i.budget_scope_id IS NOT NULL;
        PRAGMA user_version=22;
      `);
    });
    if (version < 23) this.transaction(() => {
      // Complete the context policy contract: policy digests are persisted on
      // the binding, constraints are frozen with each resolution, review
      // independence is first-class, and handoff versions are unique per task.
      this.db.exec(`
        ALTER TABLE budget_scopes ADD COLUMN root_task_id TEXT REFERENCES tasks(id);
        UPDATE budget_scopes SET root_task_id=task_id WHERE root_task_id IS NULL;

        ALTER TABLE agent_context_bindings ADD COLUMN model_policy_digest TEXT;
        ALTER TABLE agent_context_bindings ADD COLUMN tool_policy_digest TEXT;

        ALTER TABLE context_resolutions ADD COLUMN constraints_digest TEXT NOT NULL DEFAULT '';
        ALTER TABLE context_resolutions ADD COLUMN review_policy TEXT;
      `);
      // v22 wrote version=1 for every handoff. Renumber each task's history
      // before enforcing the intended UNIQUE(task_id,version) contract.
      this.db.exec(`
        UPDATE context_handoffs
        SET version=(
          SELECT COUNT(*) FROM context_handoffs prior
          WHERE prior.task_id=context_handoffs.task_id
            AND (prior.created_at<context_handoffs.created_at
              OR (prior.created_at=context_handoffs.created_at AND prior.rowid<=context_handoffs.rowid))
        );
        CREATE UNIQUE INDEX context_handoffs_task_version ON context_handoffs(task_id,version);
        PRAGMA user_version=23;
      `);
    });
    if (version < 24) this.transaction(() => {
      // A predecessor may publish one structured work-result handoff per
      // operation. Downstream Fresh nodes choose per incoming dependency
      // whether that handoff is projected or only frozen evidence is visible.
      this.db.exec(`
        ALTER TABLE context_resolutions ADD COLUMN predecessor_policy TEXT NOT NULL DEFAULT '[]';
        CREATE TABLE result_handoffs(
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          node_id TEXT NOT NULL,
          instance_id TEXT NOT NULL REFERENCES instances(id),
          operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
          activation_id TEXT NOT NULL,
          output_version INTEGER NOT NULL,
          schema_kind TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          body TEXT NOT NULL,
          digest TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX result_handoffs_source
          ON result_handoffs(task_id,node_id,activation_id,output_version);
        PRAGMA user_version=24;
      `);
    });
    if (version < 25) this.transaction(() => {
      // User-facing questions contain only decisions/permissions the user can
      // actually resolve. Runtime failures are owned by the main Agent first.
      const columns = new Set((this.db.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map(row => row.name));
      if (columns.size) {
        if (!columns.has('owner')) this.db.exec("ALTER TABLE questions ADD COLUMN owner TEXT NOT NULL DEFAULT 'user';");
        this.db.exec('CREATE INDEX IF NOT EXISTS questions_owner_status ON questions(owner,status);');
      }
      this.db.exec('PRAGMA user_version=25;');
    });
    if (version < 26) this.transaction(() => {
      // v25 defaulted every pre-existing question to owner='user'. Internal
      // execution problems that a conversation master can take over must not
      // stay in the user's inbox after an upgrade; only real decisions,
      // permissions, budget and human checks remain user-owned.
      const columns = new Set((this.db.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map(row => row.name));
      if (columns.has('owner')) {
        this.db.exec(`
          UPDATE questions SET owner='main'
          WHERE owner='user'
            AND kind NOT IN ('permission','budget','reservation_exceeded','human_check')
            AND NOT (kind='waiting' AND json_extract(data,'$.requestType')='model_access')
            AND task_id IN (
              SELECT t.id FROM tasks t
              JOIN conversations c ON c.id=t.conversation_id
              JOIN nodes n ON n.task_id=c.anchor_task_id AND json_extract(n.spec,'$.role')='master'
            );
        `);
      }
      this.db.exec('PRAGMA user_version=26;');
    });
    if (version < 27) this.transaction(() => {
      // Streaming text is a recoverable projection, not an in-memory-only
      // tail. Reconnects can restore the exact active response while live
      // deltas continue to carry stable identity and length checks.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_streams(
          operation_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          entry_id TEXT NOT NULL,
          part_id TEXT NOT NULL,
          text TEXT NOT NULL,
          length INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS conversation_streams_scope ON conversation_streams(conversation_id, updated_at);
        PRAGMA user_version=27;
      `);
    });
    if (version < 28) this.transaction(() => {
      // Shared artifacts are immutable, task-scoped published objects. SQLite
      // owns discovery, provenance and versioning; the filesystem only stores
      // content-addressed bytes.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts(
          artifact_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('task','project')),
          owner_id TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          project_id TEXT,
          namespace TEXT NOT NULL,
          name TEXT NOT NULL,
          logical_key TEXT NOT NULL,
          digest TEXT NOT NULL,
          object_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          media_type TEXT NOT NULL,
          schema_kind TEXT,
          schema_version INTEGER,
          title TEXT,
          summary TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          producer_node_id TEXT,
          producer_instance_id TEXT,
          producer_operation_id TEXT,
          producer_activation_id TEXT,
          producer_output_version INTEGER,
          visibility TEXT NOT NULL,
          trust TEXT NOT NULL,
          state TEXT NOT NULL,
          supersedes_artifact_id TEXT,
          supersedes_version INTEGER,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          PRIMARY KEY(artifact_id,version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS artifacts_logical_version
          ON artifacts(scope,owner_id,namespace,name,version);
        CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id,created_at);
        CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id,created_at);
        CREATE INDEX IF NOT EXISTS artifacts_digest ON artifacts(digest);
        CREATE INDEX IF NOT EXISTS artifacts_state ON artifacts(scope,owner_id,state,created_at);

        CREATE TABLE IF NOT EXISTS artifact_links(
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(artifact_id,version,subject_kind,subject_id,relation)
        );
        CREATE INDEX IF NOT EXISTS artifact_links_subject ON artifact_links(subject_kind,subject_id);

        CREATE TABLE IF NOT EXISTS artifact_events(
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          artifact_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS artifact_events_scope ON artifact_events(task_id,cursor);
        PRAGMA user_version=28;
      `);
    });
    if (version < 29) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rsi_continuations(
          request_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL REFERENCES operations(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          node_id TEXT NOT NULL,
          commit_sha TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('waiting','ready','consumed','cancelled')),
          resumed_operation_id TEXT REFERENCES operations(id)
        );
        CREATE INDEX IF NOT EXISTS rsi_continuations_ready ON rsi_continuations(task_id,node_id,state);
        PRAGMA user_version=29;
      `);
    });
    if (version < 30) this.transaction(() => {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS events_task_timestamp ON events(task_id,timestamp);
        CREATE INDEX IF NOT EXISTS events_task_cursor ON events(task_id,cursor);
        CREATE INDEX IF NOT EXISTS events_operation ON events(task_id,type,json_extract(data,'$.operationId'));
        CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);
        CREATE INDEX IF NOT EXISTS operations_task_node ON operations(task_id,node_id);
        CREATE INDEX IF NOT EXISTS operations_state ON operations(state);
        CREATE INDEX IF NOT EXISTS invocations_operation ON invocations(operation_id);
        CREATE INDEX IF NOT EXISTS node_capabilities_operation ON node_capabilities(operation_id);
        CREATE INDEX IF NOT EXISTS messages_operation ON messages(operation_id,state);
        CREATE INDEX IF NOT EXISTS questions_task_status ON questions(task_id,status,owner);
        PRAGMA user_version=30;
      `);
    });
    if (version < 31) this.transaction(() => {
      // A live conversation stream is one text part, not one operation: a single
      // assistant message can emit text, call a tool and emit text again, and the
      // transcript has to keep those parts apart and in the order they happened.
      // ordinal is that order, shared with the live tool activity.
      this.db.exec(`
        CREATE TABLE conversation_streams_next(
          operation_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          entry_id TEXT NOT NULL,
          part_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          length INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(operation_id, entry_id, part_id)
        );
        INSERT INTO conversation_streams_next(operation_id,conversation_id,entry_id,part_id,ordinal,text,length,updated_at)
          SELECT operation_id,conversation_id,entry_id,part_id,0,text,length,updated_at FROM conversation_streams;
        DROP TABLE conversation_streams;
        ALTER TABLE conversation_streams_next RENAME TO conversation_streams;
        CREATE INDEX IF NOT EXISTS conversation_streams_scope ON conversation_streams(conversation_id, updated_at);
        PRAGMA user_version=31;
      `);
    });
    if (version < 32) this.transaction(() => {
      // "This turn already wrote its final answer" used to be inferred from a
      // three-part message query; a column makes it a fact about the turn, so a
      // future edit to that query cannot silently drop every reply.
      const columns = new Set((this.db.prepare('PRAGMA table_info(operations)').all() as { name: string }[]).map(row => row.name));
      if (!columns.has('replied_at')) this.db.exec('ALTER TABLE operations ADD COLUMN replied_at INTEGER;');
      this.db.exec('PRAGMA user_version=32;');
    });
    if (version < 33) this.transaction(() => {
      // A pause that soft-stops a running master turn remembers the durable
      // intent to continue that exact turn, so resume re-dispatches it once
      // instead of waiting for a brand new user message. Same waiting/ready/
      // consumed wake-up shape as rsi_continuations.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pause_continuations(
          request_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL REFERENCES operations(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          node_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('waiting','ready','consumed','cancelled')),
          resumed_operation_id TEXT REFERENCES operations(id)
        );
        CREATE INDEX IF NOT EXISTS pause_continuations_ready ON pause_continuations(task_id,node_id,state);
        PRAGMA user_version=33;
      `);
    });
    if (version < 34) this.transaction(() => {
      // The console must be able to show the system prompt the model actually received. Fresh and
      // existing databases both take the column from this ALTER, as every other added column does.
      // Existing rows stay NULL (= not recorded), which the console reports as such.
      this.db.exec('ALTER TABLE operations ADD COLUMN system_prompt TEXT; PRAGMA user_version=34;');
    });
    if (version < 35) this.transaction(() => {
      // The console also shows the tool declarations one request carried. They are recorded
      // beside the prompt, at the same call site, and are display-only: nothing here is sent.
      // Existing rows stay NULL (= not recorded), which the console reports as such.
      this.db.exec('ALTER TABLE operations ADD COLUMN tool_declarations TEXT; PRAGMA user_version=35;');
    });
    if (version < 36) this.transaction(() => {
      // Durable per-tool telemetry: one append-only row per executed tool call, so call counts,
      // success rates and durations accumulate across restarts instead of dying with the process.
      // IF NOT EXISTS keeps a downgraded database (a test that pins an older user_version without
      // dropping this table) from failing to reopen.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_calls(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id TEXT NOT NULL,
          task_id TEXT,
          node_id TEXT,
          role TEXT,
          tool TEXT NOT NULL,
          ms INTEGER NOT NULL,
          is_error INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls(tool, created_at);
        PRAGMA user_version=36;`);
    });
    if (version < 37) this.transaction(() => {
      // A worker lane runs in a child process that holds no store, so its calls are spooled to a
      // file and folded in on the next read. This offset is what makes that ingest idempotent.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_call_spools(
          path TEXT PRIMARY KEY,
          offset INTEGER NOT NULL
        );
        PRAGMA user_version=37;`);
    });
    if (version < 38) this.transaction(() => {
      // Which file a call touched is what makes "this skill was read" observable at all. It rides on
      // the same row so retention and attribution keep working unchanged (NULL when a call has no
      // single target, e.g. bash). Guarded by a column check because a fixture can legitimately replay
      // the migration chain over a database that already has the column (it simulates an old version
      // by lowering user_version), and a bare ALTER would then abort the whole open.
      const columns = this.db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'target')) {
        this.db.exec('ALTER TABLE tool_calls ADD COLUMN target TEXT;');
      }
      this.db.exec('PRAGMA user_version=38;');
    });
  }

  /** How long a recorded tool call stays visible in the aggregated statistics. */
  static readonly TOOL_CALL_RETENTION_DAYS = 90;

  /**
   * Record one executed tool call. Called from the runtime seam that surrounds every tool, so a
   * failure here must never be able to break a turn - the caller guards it, and the write itself
   * stays a single statement.
   *
   * Attribution is resolved once, at write time, from the node that owns the instance: `nodes`
   * identifies it uniquely through `instance_id`, and `spec.role` names the Agent role (master,
   * coder, ...). An instance with no node row records `null` attribution rather than guessing.
   */
  recordToolCall(input: { instanceId: string; tool: string; ms: number; isError: boolean; at?: number; target?: string | null }): void {
    const node = this.db.prepare(
      `SELECT n.task_id AS task_id, n.id AS node_id, json_extract(n.spec, '$.role') AS role FROM nodes n WHERE n.instance_id = ?`,
    ).get(input.instanceId) as { task_id: string; node_id: string; role: string | null } | undefined;
    this.db.prepare(
      'INSERT INTO tool_calls(instance_id, task_id, node_id, role, tool, ms, is_error, created_at, target) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      input.instanceId, node?.task_id ?? null, node?.node_id ?? null, node?.role ?? null,
      input.tool, Math.max(0, Math.round(input.ms)), input.isError ? 1 : 0, input.at ?? Date.now(),
      input.target ?? null,
    );
  }

  /**
   * Aggregate the retained tool calls by tool and role. Reading prunes too: retention costs no
   * timer and no extra state, it is enforced exactly when someone looks at the numbers.
   */
  toolCallStats(keepDays = TaskStore.TOOL_CALL_RETENTION_DAYS): Array<{
    tool: string; role: string | null; calls: number; errors: number; totalMs: number; maxMs: number; lastAt: number;
  }> {
    this.pruneToolCalls(keepDays);
    const rows = this.db.prepare(
      `SELECT tool, role, count(*) AS calls, sum(is_error) AS errors, sum(ms) AS total_ms, max(ms) AS max_ms, max(created_at) AS last_at
       FROM tool_calls GROUP BY tool, role ORDER BY calls DESC, tool`,
    ).all() as Array<{ tool: string; role: string | null; calls: number; errors: number; total_ms: number; max_ms: number; last_at: number }>;
    return rows.map(row => ({
      tool: row.tool, role: row.role, calls: Number(row.calls), errors: Number(row.errors),
      totalMs: Number(row.total_ms), maxMs: Number(row.max_ms), lastAt: Number(row.last_at),
    }));
  }

  /** Drop the recorded tool calls, so a stale sample cannot be mistaken for a fresh one. */
  clearToolCalls(): number {
    const result = this.db.prepare('DELETE FROM tool_calls').run();
    return Number(result.changes);
  }

  /** Delete tool calls older than the retention window. Returns how many rows went. */
  pruneToolCalls(keepDays = TaskStore.TOOL_CALL_RETENTION_DAYS): number {
    const cutoff = Date.now() - keepDays * 86_400_000;
    const result = this.db.prepare('DELETE FROM tool_calls WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  /** How far one spooled worker file has already been folded into `tool_calls`. */
  toolCallSpoolOffset(path: string): number {
    const row = this.db.prepare('SELECT offset FROM tool_call_spools WHERE path = ?').get(path) as { offset: number } | undefined;
    return Number(row?.offset ?? 0);
  }

  setToolCallSpoolOffset(path: string, offset: number): void {
    this.db.prepare(
      'INSERT INTO tool_call_spools(path, offset) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset',
    ).run(path, Math.max(0, Math.round(offset)));
  }

  /** Forget every spool offset, so a cleared sample cannot be read back out of the files. */
  forgetToolCallSpools(): void {
    this.db.prepare('DELETE FROM tool_call_spools').run();
  }

  /** Forget one spool file, once the rows it produced are the only record left. */
  forgetToolCallSpool(path: string): void {
    this.db.prepare('DELETE FROM tool_call_spools WHERE path = ?').run(path);
  }
  /**
   * The exact system prompt and tool declarations of one node's newest send.
   *
   * One reader serves every node: the master's turn and a subagent's round are the same
   * record, so a per-node view cannot drift from what the model really received.
   */
  nodeSystemPrompt(taskId: string, nodeId: string): { operationId: string; at: number; text: string; tools: string | null } | null {
    const row = this.db.prepare(`SELECT id, settled_at, dispatched_at, system_prompt, tool_declarations FROM operations
      WHERE task_id = ? AND node_id = ? AND system_prompt IS NOT NULL
      ORDER BY rowid DESC LIMIT 1`).get(taskId, nodeId) as
      { id: string; settled_at: number | null; dispatched_at: number | null; system_prompt: string; tool_declarations: string | null } | undefined;
    if (!row) return null;
    return { operationId: row.id, at: row.settled_at ?? row.dispatched_at ?? 0, text: row.system_prompt, tools: row.tool_declarations };
  }

  /** The exact system prompt and tool declarations of the newest master turn that sent one. */
  conversationSystemPrompt(anchorTaskId: string): { operationId: string; at: number; text: string; tools: string | null } | null {
    return this.nodeSystemPrompt(anchorTaskId, 'master');
  }

  /** Record the exact system prompt and tool declarations one send carried; the first send of an operation wins. */
  recordOperationSystemPrompt(operationId: string, text: string, toolDeclarations?: string): void {
    this.db.prepare('UPDATE operations SET system_prompt = ?, tool_declarations = ? WHERE id = ? AND system_prompt IS NULL')
      .run(text, toolDeclarations ?? null, operationId);
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try { result = action(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.changes.emit('change'); return result;
  }
  onEvent(listener: (type: string) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
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
    for (const listener of this.eventListeners) listener(type);
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
