package graph

import (
	"context"
	"database/sql"
	"math"
	"sync"
)

// SCHEMA_VERSION is the newest tasks.sqlite this process writes.
const SCHEMA_VERSION = 42

// SchemaVersion is the same constant. Call sites used both spellings.
const SchemaVersion = SCHEMA_VERSION

// ToolCallRetentionDays is how long a recorded tool call stays in the aggregate.
const ToolCallRetentionDays = 90

// TaskRow is one tasks table row. JSON names are the SQL columns so asMap can read them.
type TaskRow struct {
	ID                 string  `json:"id"`
	ProjectID          string  `json:"project_id"`
	Request            string  `json:"request"`
	RequirementVersion int64   `json:"requirement_version"`
	LatestProposal     int64   `json:"latest_proposal"`
	AcceptedProposal   *int64  `json:"accepted_proposal"`
	TargetBranch       *string `json:"target_branch"`
	Phase              string  `json:"phase"`
	Paused             int64   `json:"paused"`
	CreatedSeq         int64   `json:"created_seq"`
	GraphVersion       int64   `json:"graph_version"`
	IntegrationBranch  *string `json:"integration_branch"`
	IntegrationSha     *string `json:"integration_sha"`
	TargetSha          *string `json:"target_sha"`
	ConversationID     *string `json:"conversation_id"`
	DecisionDigest     *string `json:"decision_digest"`
}

// TaskStore is the durable task database. DB and Db name the same connection;
// translators spelled the field both ways.
type TaskStore struct {
	DB        *sql.DB
	Db        *sql.DB
	Path      string
	mu        sync.Mutex
	listeners []func(string)
	waiters   []chan struct{}
	txDepth   int
	// txMu serializes transactions. The TypeScript host runs one event loop
	// with synchronous SQLite calls, so two transactions never interleave
	// there. The Go host serves the Pi worker protocol on its own goroutine,
	// so the same guarantee is made here: only one transaction is open.
	txMu sync.Mutex
}

func NewTaskStore(db *sql.DB, path string) *TaskStore {
	if _, err := db.Exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"); err != nil {
		panic(err)
	}
	MigrateTaskSchema(db)
	return &TaskStore{DB: db, Db: db, Path: path}
}

func OpenTaskStore(path string) *TaskStore {
	return NewTaskStore(MustOpenSQLite(path), path)
}

func (s *TaskStore) Close() {
	if s == nil || s.DB == nil {
		return
	}
	if err := s.DB.Close(); err != nil {
		panic(err)
	}
	s.emitChange()
}

// MigrateTaskSchema applies store.ts migrations in order. user_version is written by the SQL.
func MigrateTaskSchema(db *sql.DB) {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		panic(err)
	}
	if version > SCHEMA_VERSION {
		if err := db.Close(); err != nil {
			panic(err)
		}
		Raise("schema_version", "Database belongs to a newer runtime")
	}
	if version < 1 {
		execMigration(db, schemaV1)
	}
	if version < 2 {
		execMigration(db, schemaV2)
	}
	if version < 3 {
		execMigration(db, schemaV3)
	}
	if version < 4 {
		execMigration(db, schemaV4)
	}
	if version < 5 {
		execMigration(db, schemaV5)
	}
	if version < 6 {
		execMigration(db, schemaV6)
	}
	if version < 7 {
		execMigration(db, schemaV7)
	}
	if version < 8 {
		execMigration(db, schemaV8)
	}
	if version < 9 {
		execMigration(db, schemaV9)
	}
	if version < 10 {
		execMigration(db, schemaV10)
	}
	if version < 11 {
		execMigration(db, schemaV11)
	}
	if version < 12 {
		execMigration(db, schemaV12)
	}
	if version < 13 {
		execMigration(db, schemaV13)
	}
	if version < 14 {
		execMigration(db, schemaV14)
	}
	if version < 15 {
		execMigration(db, schemaV15)
	}
	if version < 16 {
		execMigration(db, schemaV16)
	}
	if version < 17 {
		execMigration(db, schemaV17)
	}
	if version < 18 {
		execMigration(db, schemaV18)
	}
	if version < 19 {
		execMigration(db, schemaV19)
	}
	if version < 20 {
		execMigration(db, schemaV20)
	}
	if version < 21 {
		execMigration(db, schemaV21)
	}
	if version < 22 {
		migrateV22(db)
	}
	if version < 23 {
		execMigration(db, schemaV23)
	}
	if version < 24 {
		execMigration(db, schemaV24)
	}
	if version < 25 {
		migrateV25(db)
	}
	if version < 26 {
		migrateV26(db)
	}
	if version < 27 {
		execMigration(db, schemaV27)
	}
	if version < 28 {
		execMigration(db, schemaV28)
	}
	if version < 29 {
		execMigration(db, schemaV29)
	}
	if version < 30 {
		execMigration(db, schemaV30)
	}
	if version < 31 {
		execMigration(db, schemaV31)
	}
	if version < 32 {
		migrateV32(db)
	}
	if version < 33 {
		execMigration(db, schemaV33)
	}
	if version < 34 {
		migrateV34(db)
	}
	if version < 35 {
		migrateV35(db)
	}
	if version < 36 {
		execMigration(db, schemaV36)
	}
	if version < 37 {
		execMigration(db, schemaV37)
	}
	if version < 38 {
		migrateV38(db)
	}
	if version < 39 {
		execMigration(db, schemaV39)
	}
	if version < 40 {
		execMigration(db, schemaV40)
	}
	if version < 41 {
		migrateV41(db)
	}
	if version < 42 {
		execMigration(db, schemaV42)
	}
}

func sqliteColumns(db *sql.DB, table string) map[string]bool {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			panic(err)
		}
		cols[name] = true
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return cols
}

func execSQL(db *sql.DB, script string) {
	if _, err := db.Exec(script); err != nil {
		panic(err)
	}
}

func migrateV22(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	execSQL(db, "\n        CREATE TABLE budget_scopes(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),\n          owner_instance_id TEXT REFERENCES instances(id), limit_tokens INTEGER, unlimited INTEGER NOT NULL,\n          used_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);\n        CREATE INDEX budget_scopes_task ON budget_scopes(task_id);\n      ")
	cols := sqliteColumns(db, "instances")
	if !cols["budget_scope_id"] {
		execSQL(db, "ALTER TABLE instances ADD COLUMN budget_scope_id TEXT REFERENCES budget_scopes(id);")
	}
	if !cols["parent_instance_id"] {
		execSQL(db, "ALTER TABLE instances ADD COLUMN parent_instance_id TEXT REFERENCES instances(id);")
	}
	execSQL(db, "\n        INSERT INTO budget_scopes(id,task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at)\n          SELECT lower(hex(randomblob(16))),task_id,id,CASE WHEN unlimited=1 THEN NULL ELSE budget END,unlimited,used,0 FROM instances;\n        UPDATE instances SET budget_scope_id=(SELECT id FROM budget_scopes s WHERE s.owner_instance_id=instances.id);\n        CREATE TABLE context_handoffs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),\n          operation_id TEXT REFERENCES operations(id), version INTEGER NOT NULL, purpose TEXT NOT NULL,\n          summary TEXT NOT NULL, package TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL);\n        CREATE INDEX context_handoffs_task ON context_handoffs(task_id,created_at);\n        CREATE TABLE agent_context_bindings(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),\n          node_id TEXT NOT NULL, instance_id TEXT NOT NULL UNIQUE REFERENCES instances(id),\n          mode TEXT NOT NULL CHECK(mode IN ('fresh','fork')), source_instance_id TEXT REFERENCES instances(id),\n          source_session_id TEXT, source_session_file TEXT, source_leaf_id TEXT, source_context_digest TEXT,\n          child_context_digest TEXT, handoff_id TEXT REFERENCES context_handoffs(id), capability_digest TEXT,\n          budget_scope_id TEXT NOT NULL REFERENCES budget_scopes(id), created_at INTEGER NOT NULL);\n        CREATE INDEX agent_context_bindings_task ON agent_context_bindings(task_id,node_id);\n        CREATE TABLE context_resolutions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),\n          node_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),\n          requested_purpose TEXT NOT NULL, requested_facts TEXT NOT NULL DEFAULT '[]', independence TEXT NOT NULL,\n          selected_mode TEXT NOT NULL CHECK(selected_mode IN ('continue','fresh','fork')),\n          reason_code TEXT NOT NULL, source_instance_id TEXT REFERENCES instances(id),\n          binding_id TEXT NOT NULL REFERENCES agent_context_bindings(id), handoff_id TEXT NOT NULL REFERENCES context_handoffs(id),\n          created_at INTEGER NOT NULL);\n        CREATE INDEX context_resolutions_binding ON context_resolutions(binding_id,created_at);\n        INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,budget_scope_id,created_at)\n          SELECT lower(hex(randomblob(16))),i.task_id,i.node_id,i.id,'fresh',i.budget_scope_id,0\n          FROM instances i JOIN node_sessions s ON s.instance_id=i.id\n          WHERE i.budget_scope_id IS NOT NULL;\n        PRAGMA user_version=22;\n      ")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV25(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "questions")
	if len(cols) > 0 {
		if !cols["owner"] {
			execSQL(db, "ALTER TABLE questions ADD COLUMN owner TEXT NOT NULL DEFAULT 'user';")
		}
		execSQL(db, "CREATE INDEX IF NOT EXISTS questions_owner_status ON questions(owner,status);")
	}
	execSQL(db, "PRAGMA user_version=25;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV26(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "questions")
	if cols["owner"] {
		execSQL(db, "\n          UPDATE questions SET owner='main'\n          WHERE owner='user'\n            AND kind NOT IN ('permission','budget','reservation_exceeded','human_check')\n            AND NOT (kind='waiting' AND json_extract(data,'$.requestType')='model_access')\n            AND task_id IN (\n              SELECT t.id FROM tasks t\n              JOIN conversations c ON c.id=t.conversation_id\n              JOIN nodes n ON n.task_id=c.anchor_task_id AND json_extract(n.spec,'$.role')='master'\n            );\n        ")
	}
	execSQL(db, "PRAGMA user_version=26;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV32(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "operations")
	if !cols["replied_at"] {
		execSQL(db, "ALTER TABLE operations ADD COLUMN replied_at INTEGER;")
	}
	execSQL(db, "PRAGMA user_version=32;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV34(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "operations")
	if !cols["system_prompt"] {
		execSQL(db, "ALTER TABLE operations ADD COLUMN system_prompt TEXT;")
	}
	execSQL(db, "PRAGMA user_version=34;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV35(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "operations")
	if !cols["tool_declarations"] {
		execSQL(db, "ALTER TABLE operations ADD COLUMN tool_declarations TEXT;")
	}
	execSQL(db, "PRAGMA user_version=35;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV38(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "tool_calls")
	if !cols["target"] {
		execSQL(db, "ALTER TABLE tool_calls ADD COLUMN target TEXT;")
	}
	execSQL(db, "PRAGMA user_version=38;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrateV41(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	cols := sqliteColumns(db, "messages")
	if !cols["node_id"] {
		execSQL(db, "ALTER TABLE messages ADD COLUMN node_id TEXT")
	}
	if !cols["to_node_id"] {
		execSQL(db, "ALTER TABLE messages ADD COLUMN to_node_id TEXT")
	}
	if !cols["request_id"] {
		execSQL(db, "ALTER TABLE messages ADD COLUMN request_id TEXT")
	}
	if cols["conversation_id"] {
		execSQL(db, "\n        CREATE INDEX IF NOT EXISTS messages_to_node ON messages(conversation_id,to_node_id,seq);\n        CREATE UNIQUE INDEX IF NOT EXISTS messages_request ON messages(conversation_id,request_id) WHERE request_id IS NOT NULL;")
	}
	execSQL(db, "PRAGMA user_version=41;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

const schemaV12 = "ALTER TABLE tasks ADD COLUMN decision_digest TEXT; PRAGMA user_version=12;"

const schemaV13 = "\n        ALTER TABLE proposals ADD COLUMN decision_snapshot TEXT;\n        ALTER TABLE conversations ADD COLUMN binding_since_seq INTEGER NOT NULL DEFAULT 0;\n        PRAGMA user_version=13;"

const schemaV14 = "ALTER TABLE instances ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=14;"

const schemaV15 = "\n        CREATE TABLE project_preparation(project_id TEXT PRIMARY KEY REFERENCES projects(id),\n          state TEXT NOT NULL, repo_root TEXT, project_subdir TEXT, branch TEXT, baseline_sha TEXT,\n          detail TEXT, updated_at INTEGER NOT NULL);\n        PRAGMA user_version=15;"

const schemaV16 = "\n        CREATE TABLE presets(id TEXT PRIMARY KEY, version TEXT NOT NULL, hash TEXT NOT NULL,\n          detail TEXT, installed_at INTEGER NOT NULL);\n        PRAGMA user_version=16;"

const schemaV17 = "\n        CREATE TABLE node_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,\n          task_id TEXT NOT NULL, node_id TEXT NOT NULL, instance_id TEXT, activation_id TEXT, operation_id TEXT,\n          role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', data TEXT,\n          created_at INTEGER NOT NULL);\n        CREATE INDEX node_entries_scope ON node_entries(task_id,node_id,seq);\n        CREATE TABLE node_sessions(instance_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,\n          session_file TEXT, updated_at INTEGER NOT NULL);\n        ALTER TABLE operations ADD COLUMN dispatched_at INTEGER;\n        ALTER TABLE operations ADD COLUMN settled_at INTEGER;\n        ALTER TABLE operations ADD COLUMN waiting_since INTEGER;\n        ALTER TABLE operations ADD COLUMN waiting_ms INTEGER NOT NULL DEFAULT 0;\n        PRAGMA user_version=17;"

const schemaV18 = "\n        CREATE TABLE node_capabilities(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,\n          node_id TEXT NOT NULL, instance_id TEXT, operation_id TEXT, read_only INTEGER NOT NULL,\n          loaded TEXT NOT NULL, created_at INTEGER NOT NULL);\n        CREATE INDEX node_capabilities_scope ON node_capabilities(task_id,node_id,seq);\n        PRAGMA user_version=18;"

const schemaV19 = "\n        ALTER TABLE nodes ADD COLUMN pause_ms INTEGER;\n        ALTER TABLE nodes ADD COLUMN pause_since INTEGER;\n        ALTER TABLE nodes ADD COLUMN user_wait_ms INTEGER;\n        ALTER TABLE nodes ADD COLUMN user_wait_since INTEGER;\n        PRAGMA user_version=19;"

const schemaV20 = "\n        ALTER TABLE invocations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'completion';\n        PRAGMA user_version=20;"

const schemaV21 = "\n        ALTER TABLE conversations ADD COLUMN archived_at INTEGER;\n        ALTER TABLE conversations ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off';\n        CREATE INDEX conversations_archived ON conversations(archived_at);\n        PRAGMA user_version=21;"

const schemaV23 = "\n        ALTER TABLE budget_scopes ADD COLUMN root_task_id TEXT REFERENCES tasks(id);\n        UPDATE budget_scopes SET root_task_id=task_id WHERE root_task_id IS NULL;\n\n        ALTER TABLE agent_context_bindings ADD COLUMN model_policy_digest TEXT;\n        ALTER TABLE agent_context_bindings ADD COLUMN tool_policy_digest TEXT;\n\n        ALTER TABLE context_resolutions ADD COLUMN constraints_digest TEXT NOT NULL DEFAULT '';\n        ALTER TABLE context_resolutions ADD COLUMN review_policy TEXT;\n      \n\n        UPDATE context_handoffs\n        SET version=(\n          SELECT COUNT(*) FROM context_handoffs prior\n          WHERE prior.task_id=context_handoffs.task_id\n            AND (prior.created_at<context_handoffs.created_at\n              OR (prior.created_at=context_handoffs.created_at AND prior.rowid<=context_handoffs.rowid))\n        );\n        CREATE UNIQUE INDEX context_handoffs_task_version ON context_handoffs(task_id,version);\n        PRAGMA user_version=23;\n      "

const schemaV24 = "\n        ALTER TABLE context_resolutions ADD COLUMN predecessor_policy TEXT NOT NULL DEFAULT '[]';\n        CREATE TABLE result_handoffs(\n          id TEXT PRIMARY KEY,\n          task_id TEXT NOT NULL REFERENCES tasks(id),\n          node_id TEXT NOT NULL,\n          instance_id TEXT NOT NULL REFERENCES instances(id),\n          operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),\n          activation_id TEXT NOT NULL,\n          output_version INTEGER NOT NULL,\n          schema_kind TEXT NOT NULL,\n          schema_version INTEGER NOT NULL,\n          body TEXT NOT NULL,\n          digest TEXT NOT NULL,\n          created_at INTEGER NOT NULL\n        );\n        CREATE INDEX result_handoffs_source\n          ON result_handoffs(task_id,node_id,activation_id,output_version);\n        PRAGMA user_version=24;\n      "

const schemaV27 = "\n        CREATE TABLE IF NOT EXISTS conversation_streams(\n          operation_id TEXT PRIMARY KEY,\n          conversation_id TEXT NOT NULL REFERENCES conversations(id),\n          entry_id TEXT NOT NULL,\n          part_id TEXT NOT NULL,\n          text TEXT NOT NULL,\n          length INTEGER NOT NULL,\n          updated_at INTEGER NOT NULL\n        );\n        CREATE INDEX IF NOT EXISTS conversation_streams_scope ON conversation_streams(conversation_id, updated_at);\n        PRAGMA user_version=27;\n      "

const schemaV28 = "\n        CREATE TABLE IF NOT EXISTS artifacts(\n          artifact_id TEXT NOT NULL,\n          version INTEGER NOT NULL,\n          scope TEXT NOT NULL CHECK(scope IN ('task','project')),\n          owner_id TEXT NOT NULL,\n          task_id TEXT NOT NULL REFERENCES tasks(id),\n          project_id TEXT,\n          namespace TEXT NOT NULL,\n          name TEXT NOT NULL,\n          logical_key TEXT NOT NULL,\n          digest TEXT NOT NULL,\n          object_path TEXT NOT NULL,\n          size INTEGER NOT NULL,\n          media_type TEXT NOT NULL,\n          schema_kind TEXT,\n          schema_version INTEGER,\n          title TEXT,\n          summary TEXT,\n          tags TEXT NOT NULL DEFAULT '[]',\n          producer_node_id TEXT,\n          producer_instance_id TEXT,\n          producer_operation_id TEXT,\n          producer_activation_id TEXT,\n          producer_output_version INTEGER,\n          visibility TEXT NOT NULL,\n          trust TEXT NOT NULL,\n          state TEXT NOT NULL,\n          supersedes_artifact_id TEXT,\n          supersedes_version INTEGER,\n          metadata TEXT NOT NULL DEFAULT '{}',\n          created_at INTEGER NOT NULL,\n          retired_at INTEGER,\n          PRIMARY KEY(artifact_id,version)\n        );\n        CREATE UNIQUE INDEX IF NOT EXISTS artifacts_logical_version\n          ON artifacts(scope,owner_id,namespace,name,version);\n        CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id,created_at);\n        CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id,created_at);\n        CREATE INDEX IF NOT EXISTS artifacts_digest ON artifacts(digest);\n        CREATE INDEX IF NOT EXISTS artifacts_state ON artifacts(scope,owner_id,state,created_at);\n\n        CREATE TABLE IF NOT EXISTS artifact_links(\n          id TEXT PRIMARY KEY,\n          artifact_id TEXT NOT NULL,\n          version INTEGER NOT NULL,\n          subject_kind TEXT NOT NULL,\n          subject_id TEXT NOT NULL,\n          relation TEXT NOT NULL,\n          created_at INTEGER NOT NULL,\n          UNIQUE(artifact_id,version,subject_kind,subject_id,relation)\n        );\n        CREATE INDEX IF NOT EXISTS artifact_links_subject ON artifact_links(subject_kind,subject_id);\n\n        CREATE TABLE IF NOT EXISTS artifact_events(\n          cursor INTEGER PRIMARY KEY AUTOINCREMENT,\n          task_id TEXT NOT NULL REFERENCES tasks(id),\n          artifact_id TEXT NOT NULL,\n          version INTEGER NOT NULL,\n          type TEXT NOT NULL,\n          data TEXT NOT NULL,\n          timestamp INTEGER NOT NULL\n        );\n        CREATE INDEX IF NOT EXISTS artifact_events_scope ON artifact_events(task_id,cursor);\n        PRAGMA user_version=28;\n      "

const schemaV29 = "\n        CREATE TABLE IF NOT EXISTS rsi_continuations(\n          request_id TEXT PRIMARY KEY,\n          operation_id TEXT NOT NULL REFERENCES operations(id),\n          task_id TEXT NOT NULL REFERENCES tasks(id),\n          node_id TEXT NOT NULL,\n          commit_sha TEXT NOT NULL,\n          state TEXT NOT NULL CHECK(state IN ('waiting','ready','consumed','cancelled')),\n          resumed_operation_id TEXT REFERENCES operations(id)\n        );\n        CREATE INDEX IF NOT EXISTS rsi_continuations_ready ON rsi_continuations(task_id,node_id,state);\n        PRAGMA user_version=29;\n      "

const schemaV30 = "\n        CREATE INDEX IF NOT EXISTS events_task_timestamp ON events(task_id,timestamp);\n        CREATE INDEX IF NOT EXISTS events_task_cursor ON events(task_id,cursor);\n        CREATE INDEX IF NOT EXISTS events_operation ON events(task_id,type,json_extract(data,'$.operationId'));\n        CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);\n        CREATE INDEX IF NOT EXISTS operations_task_node ON operations(task_id,node_id);\n        CREATE INDEX IF NOT EXISTS operations_state ON operations(state);\n        CREATE INDEX IF NOT EXISTS invocations_operation ON invocations(operation_id);\n        CREATE INDEX IF NOT EXISTS node_capabilities_operation ON node_capabilities(operation_id);\n        CREATE INDEX IF NOT EXISTS messages_operation ON messages(operation_id,state);\n        CREATE INDEX IF NOT EXISTS questions_task_status ON questions(task_id,status,owner);\n        PRAGMA user_version=30;\n      "

const schemaV31 = "\n        CREATE TABLE conversation_streams_next(\n          operation_id TEXT NOT NULL,\n          conversation_id TEXT NOT NULL REFERENCES conversations(id),\n          entry_id TEXT NOT NULL,\n          part_id TEXT NOT NULL,\n          ordinal INTEGER NOT NULL DEFAULT 0,\n          text TEXT NOT NULL,\n          length INTEGER NOT NULL,\n          updated_at INTEGER NOT NULL,\n          PRIMARY KEY(operation_id, entry_id, part_id)\n        );\n        INSERT INTO conversation_streams_next(operation_id,conversation_id,entry_id,part_id,ordinal,text,length,updated_at)\n          SELECT operation_id,conversation_id,entry_id,part_id,0,text,length,updated_at FROM conversation_streams;\n        DROP TABLE conversation_streams;\n        ALTER TABLE conversation_streams_next RENAME TO conversation_streams;\n        CREATE INDEX IF NOT EXISTS conversation_streams_scope ON conversation_streams(conversation_id, updated_at);\n        PRAGMA user_version=31;\n      "

const schemaV33 = "\n        CREATE TABLE IF NOT EXISTS pause_continuations(\n          request_id TEXT PRIMARY KEY,\n          operation_id TEXT NOT NULL REFERENCES operations(id),\n          task_id TEXT NOT NULL REFERENCES tasks(id),\n          node_id TEXT NOT NULL,\n          state TEXT NOT NULL CHECK(state IN ('waiting','ready','consumed','cancelled')),\n          resumed_operation_id TEXT REFERENCES operations(id)\n        );\n        CREATE INDEX IF NOT EXISTS pause_continuations_ready ON pause_continuations(task_id,node_id,state);\n        PRAGMA user_version=33;\n      "

const schemaV36 = "\n        CREATE TABLE IF NOT EXISTS tool_calls(\n          id INTEGER PRIMARY KEY AUTOINCREMENT,\n          instance_id TEXT NOT NULL,\n          task_id TEXT,\n          node_id TEXT,\n          role TEXT,\n          tool TEXT NOT NULL,\n          ms INTEGER NOT NULL,\n          is_error INTEGER NOT NULL DEFAULT 0,\n          created_at INTEGER NOT NULL);\n        CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls(tool, created_at);\n        PRAGMA user_version=36;"

const schemaV37 = "\n        CREATE TABLE IF NOT EXISTS tool_call_spools(\n          path TEXT PRIMARY KEY,\n          offset INTEGER NOT NULL\n        );\n        PRAGMA user_version=37;"

const schemaV39 = "\n        CREATE TABLE IF NOT EXISTS node_write_captures(\n          task_id TEXT NOT NULL, node_id TEXT NOT NULL, instance_id TEXT, turn_id TEXT NOT NULL,\n          path TEXT NOT NULL, tool_name TEXT NOT NULL, tool_call_id TEXT NOT NULL,\n          before TEXT NOT NULL, after TEXT, created_at INTEGER NOT NULL,\n          PRIMARY KEY(task_id,node_id,turn_id,path));\n        CREATE INDEX IF NOT EXISTS node_write_captures_node ON node_write_captures(task_id,node_id,created_at);\n        PRAGMA user_version=39;"

const schemaV40 = "\n        CREATE TABLE IF NOT EXISTS wake_intents(\n          id INTEGER PRIMARY KEY AUTOINCREMENT,\n          task_id TEXT NOT NULL REFERENCES tasks(id),\n          node_id TEXT NOT NULL,\n          kind TEXT NOT NULL,\n          dedupe_key TEXT NOT NULL,\n          data TEXT,\n          state TEXT NOT NULL CHECK(state IN ('waiting','ready','consumed')),\n          consumed_operation_id TEXT REFERENCES operations(id),\n          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),\n          UNIQUE(task_id,node_id,kind,dedupe_key));\n        CREATE INDEX IF NOT EXISTS wake_intents_ready ON wake_intents(task_id,node_id,state);\n        PRAGMA user_version=40;"

const schemaV42 = "\n        ALTER TABLE proposals ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1;\n        ALTER TABLE proposals ADD COLUMN draft_digest TEXT;\n        ALTER TABLE proposals ADD COLUMN archived_at INTEGER;\n        ALTER TABLE proposals ADD COLUMN deleted_at INTEGER;\n        ALTER TABLE conversation_acceptances ADD COLUMN draft_revision INTEGER;\n        PRAGMA user_version=42;"

func (s *TaskStore) emitChange() {
	s.mu.Lock()
	waiters := s.waiters
	s.waiters = nil
	listeners := append([]func(string){}, s.listeners...)
	s.mu.Unlock()
	for _, waiter := range waiters {
		select {
		case waiter <- struct{}{}:
		default:
		}
	}
	for _, listener := range listeners {
		_ = listener
	}
}

func (s *TaskStore) OnEvent(listener func(string)) func() {
	s.mu.Lock()
	s.listeners = append(s.listeners, listener)
	index := len(s.listeners) - 1
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if index >= 0 && index < len(s.listeners) && &s.listeners[index] != nil {
				fn := s.listeners[index]
				if &fn == nil {
				}
				next := make([]func(string), 0, len(s.listeners))
				removed := false
				for i, item := range s.listeners {
					if !removed && i == index {
						removed = true
						continue
					}
					next = append(next, item)
				}
				s.listeners = next
				index = -1
			}
			s.mu.Unlock()
		})
	}
}

func (s *TaskStore) IsTransaction() bool {
	return s.InTransaction()
}

func (s *TaskStore) InTransaction() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.txDepth > 0
}

func (s *TaskStore) setTx(active bool) {
	s.mu.Lock()
	if active {
		s.txDepth++
	} else if s.txDepth > 0 {
		s.txDepth--
	}
	s.mu.Unlock()
}

// Transaction runs one database transaction.
//
// Only one transaction is open at a time, so the host behaves like the
// single-threaded TypeScript event loop it was ported from. A transaction
// opened while another one is already running joins it: SQLite has no nested
// BEGIN, and the TypeScript host would have refused the same nesting.
//
// A transaction opened from inside another one does not join it: this
// method takes the transaction lock before it looks at the depth, so the
// inner call waits for a lock the outer call is holding and the host stops
// there. A store method that has to run inside somebody else's transaction
// therefore does not open one of its own - a single statement is atomic by
// itself - and a method that needs several statements names itself
// InCurrentTransaction, which asks the caller to hold the transaction.
func (s *TaskStore) Transaction(action any) any {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	if s.InTransaction() {
		return storeTransactionAction(action)
	}
	if _, err := s.DB.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	s.setTx(true)
	var result any
	committed := false
	defer func() {
		s.setTx(false)
		if !committed {
			if _, err := s.DB.Exec("ROLLBACK"); err != nil {
				panic(err)
			}
		}
		if rec := recover(); rec != nil {
			panic(rec)
		}
	}()
	result = storeTransactionAction(action)
	if _, err := s.DB.Exec("COMMIT"); err != nil {
		panic(err)
	}
	committed = true
	s.emitChange()
	return result
}

// storeTransactionAction runs the body of a transaction.
func storeTransactionAction(action any) any {
	switch fn := action.(type) {
	case func():
		fn()
		return nil
	case func() any:
		return fn()
	default:
		Raise("invalid_input", "Unsupported transaction callback")
	}
	return nil
}

func (s *TaskStore) Command(scope, requestID string, payload any, apply func() any) any {
	if requestID == "" || len(requestID) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	encoded := CanonicalJSON(payload)
	return s.Transaction(func() any {
		var previousPayload, receipt string
		err := s.DB.QueryRow("SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", scope, requestID).Scan(&previousPayload, &receipt)
		if err == nil {
			if previousPayload != encoded {
				Raise("idempotency_conflict", "requestId was already used with different content")
			}
			return parseJSON(receipt)
		}
		if err != sql.ErrNoRows {
			panic(err)
		}
		result := apply()
		if _, err := s.DB.Exec("INSERT INTO commands VALUES(?,?,?,?)", scope, requestID, encoded, CanonicalJSON(result)); err != nil {
			panic(err)
		}
		return result
	})
}

func eventTaskID(taskID any) any {
	switch v := taskID.(type) {
	case nil:
		return nil
	case *string:
		if v == nil {
			return nil
		}
		return *v
	case string:
		return v
	default:
		return taskID
	}
}

func (s *TaskStore) Event(taskID any, eventType string, data any) int64 {
	res, err := s.DB.Exec("INSERT INTO events(task_id,type,data,timestamp) VALUES(?,?,?,?)", eventTaskID(taskID), eventType, CanonicalJSON(data), NowMillis())
	if err != nil {
		panic(err)
	}
	cursor, err := res.LastInsertId()
	if err != nil {
		panic(err)
	}
	s.emitChange()
	s.mu.Lock()
	listeners := append([]func(string){}, s.listeners...)
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(eventType)
	}
	return cursor
}

func (s *TaskStore) Task(id string) TaskRow {
	var row TaskRow
	var accepted sql.NullInt64
	var integrationBranch, integrationSha, targetSha sql.NullString
	err := s.DB.QueryRow(`SELECT id, project_id, request, requirement_version, latest_proposal, accepted_proposal, target_branch, phase, paused, created_seq, graph_version, integration_branch, integration_sha, target_sha, conversation_id, decision_digest FROM tasks WHERE id=?`, id).Scan(
		&row.ID, &row.ProjectID, &row.Request, &row.RequirementVersion, &row.LatestProposal, &accepted, &row.TargetBranch, &row.Phase, &row.Paused, &row.CreatedSeq, &row.GraphVersion, &integrationBranch, &integrationSha, &targetSha, &row.ConversationID, &row.DecisionDigest,
	)
	if accepted.Valid {
		value := accepted.Int64
		row.AcceptedProposal = &value
	}
	if integrationBranch.Valid {
		value := integrationBranch.String
		row.IntegrationBranch = &value
	}
	if integrationSha.Valid {
		value := integrationSha.String
		row.IntegrationSha = &value
	}
	if targetSha.Valid {
		value := targetSha.String
		row.TargetSha = &value
	}
	if err == sql.ErrNoRows {
		Raise("not_found", "Task not found")
	}
	if err != nil {
		panic(err)
	}
	return row
}

type ToolCallInput struct {
	InstanceID string
	Tool       string
	Ms         float64
	IsError    bool
	At         *int64
	Target     any
}

func (s *TaskStore) RecordToolCall(input ToolCallInput) {
	var taskID, nodeID, role any
	err := s.DB.QueryRow(`SELECT n.task_id, n.id, json_extract(n.spec, '$.role') FROM nodes n WHERE n.instance_id = ?`, input.InstanceID).Scan(&taskID, &nodeID, &role)
	if err == sql.ErrNoRows {
		var present int
		qerr := s.DB.QueryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_nodes'").Scan(&present)
		if qerr == nil {
			err = s.DB.QueryRow(`SELECT n.task_id,n.node_id,b.role FROM kernel_nodes n LEFT JOIN kernel_node_bindings b ON b.task_id=n.task_id AND b.node_id=n.node_id WHERE n.instance_id=?`, input.InstanceID).Scan(&taskID, &nodeID, &role)
			if err == sql.ErrNoRows {
				err = nil
				taskID, nodeID, role = nil, nil, nil
			}
		} else {
			err = nil
			taskID, nodeID, role = nil, nil, nil
		}
	}
	if err != nil {
		panic(err)
	}
	ms := int64(math.Round(input.Ms))
	if ms < 0 {
		ms = 0
	}
	at := NowMillis()
	if input.At != nil {
		at = *input.At
	}
	isError := 0
	if input.IsError {
		isError = 1
	}
	if _, err := s.DB.Exec(`INSERT INTO tool_calls(instance_id, task_id, node_id, role, tool, ms, is_error, created_at, target) VALUES(?,?,?,?,?,?,?,?,?)`, input.InstanceID, taskID, nodeID, role, input.Tool, ms, isError, at, input.Target); err != nil {
		panic(err)
	}
}

func (s *TaskStore) PruneToolCalls(keepDays int) int64 {
	if keepDays == 0 {
		keepDays = ToolCallRetentionDays
	}
	cutoff := NowMillis() - int64(keepDays)*86400000
	res, err := s.DB.Exec("DELETE FROM tool_calls WHERE created_at < ?", cutoff)
	if err != nil {
		panic(err)
	}
	n, _ := res.RowsAffected()
	return n
}

func (s *TaskStore) ClearToolCalls() int64 {
	res, err := s.DB.Exec("DELETE FROM tool_calls")
	if err != nil {
		panic(err)
	}
	n, _ := res.RowsAffected()
	return n
}

func (s *TaskStore) ToolCallSpoolOffset(path string) int64 {
	var offset sql.NullInt64
	err := s.DB.QueryRow("SELECT offset FROM tool_call_spools WHERE path = ?", path).Scan(&offset)
	if err == sql.ErrNoRows {
		return 0
	}
	if err != nil {
		panic(err)
	}
	return offset.Int64
}

func (s *TaskStore) SetToolCallSpoolOffset(path string, offset int64) {
	if offset < 0 {
		offset = 0
	}
	if _, err := s.DB.Exec("INSERT INTO tool_call_spools(path, offset) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset", path, offset); err != nil {
		panic(err)
	}
}

func (s *TaskStore) ForgetToolCallSpools() {
	if _, err := s.DB.Exec("DELETE FROM tool_call_spools"); err != nil {
		panic(err)
	}
}

func (s *TaskStore) ForgetToolCallSpool(path string) {
	if _, err := s.DB.Exec("DELETE FROM tool_call_spools WHERE path = ?", path); err != nil {
		panic(err)
	}
}

type SystemPromptRecord struct {
	OperationID string
	At          int64
	Text        string
	Tools       sql.NullString
}

func (s *TaskStore) NodeSystemPrompt(taskID, nodeID string) *SystemPromptRecord {
	var rec SystemPromptRecord
	var settled, dispatched sql.NullInt64
	err := s.DB.QueryRow(`SELECT id, settled_at, dispatched_at, system_prompt, tool_declarations FROM operations WHERE task_id = ? AND node_id = ? AND system_prompt IS NOT NULL ORDER BY rowid DESC LIMIT 1`, taskID, nodeID).Scan(&rec.OperationID, &settled, &dispatched, &rec.Text, &rec.Tools)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		panic(err)
	}
	if settled.Valid {
		rec.At = settled.Int64
	} else if dispatched.Valid {
		rec.At = dispatched.Int64
	}
	return &rec
}

func (s *TaskStore) ConversationSystemPrompt(anchorTaskID string) *SystemPromptRecord {
	return s.NodeSystemPrompt(anchorTaskID, "master")
}

func (s *TaskStore) RecordOperationSystemPrompt(operationID, text string, toolDeclarations any) {
	if _, err := s.DB.Exec("UPDATE operations SET system_prompt = ?, tool_declarations = ? WHERE id = ? AND system_prompt IS NULL", text, toolDeclarations, operationID); err != nil {
		panic(err)
	}
}

// ToolCallStat is one tool/role aggregate. Role is JSON null when the call had no role.
type ToolCallStat struct {
	Tool     string  `json:"tool"`
	Role     *string `json:"role"`
	Calls    int64   `json:"calls"`
	Errors   int64   `json:"errors"`
	TotalMs  int64   `json:"totalMs"`
	MedianMs float64 `json:"medianMs"`
	MaxMs    int64   `json:"maxMs"`
	LastAt   int64   `json:"lastAt"`
}

func (s *TaskStore) ToolCallStats(keepDays ...int) []ToolCallStat {
	days := ToolCallRetentionDays
	if len(keepDays) > 0 {
		days = keepDays[0]
	}
	s.PruneToolCalls(days)
	rows, err := s.DB.Query(`WITH ranked AS (
         SELECT tool, role, ms, is_error, created_at,
           row_number() OVER (PARTITION BY tool, role ORDER BY ms, id) AS ordinal,
           count(*) OVER (PARTITION BY tool, role) AS sample_count
         FROM tool_calls
       )
       SELECT tool, role, count(*) AS calls, sum(is_error) AS errors,
         sum(ms) AS total_ms,
         avg(CASE WHEN ordinal IN ((sample_count + 1) / 2, (sample_count + 2) / 2) THEN ms END) AS median_ms,
         max(ms) AS max_ms, max(created_at) AS last_at
       FROM ranked GROUP BY tool, role ORDER BY calls DESC, tool`)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []ToolCallStat{}
	for rows.Next() {
		var stat ToolCallStat
		var role sql.NullString
		var calls, errors, total, maxMs, last sql.NullInt64
		var median sql.NullFloat64
		if err := rows.Scan(&stat.Tool, &role, &calls, &errors, &total, &median, &maxMs, &last); err != nil {
			panic(err)
		}
		if role.Valid {
			value := role.String
			stat.Role = &value
		}
		stat.Calls = calls.Int64
		stat.Errors = errors.Int64
		stat.TotalMs = total.Int64
		stat.MedianMs = median.Float64
		stat.MaxMs = maxMs.Int64
		stat.LastAt = last.Int64
		out = append(out, stat)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

// ChangeWait is the promise/cancel pair waitForChange returned.
type ChangeWait struct {
	Promise <-chan struct{}
	Cancel  func()
}

func (s *TaskStore) WaitForChange(signal context.Context) ChangeWait {
	// The channel carries a signal, it is never closed: a writer that emits
	// while the reader is between iterations must not lose the notification,
	// and a reader that cancels must not race the writer's send.
	ch := make(chan struct{}, 1)
	var once sync.Once
	finish := func() {
		once.Do(func() {
			s.mu.Lock()
			next := s.waiters[:0]
			for _, waiter := range s.waiters {
				if waiter != ch {
					next = append(next, waiter)
				}
			}
			s.waiters = next
			s.mu.Unlock()
			select {
			case ch <- struct{}{}:
			default:
			}
		})
	}
	if signal != nil && signal.Err() != nil {
		finish()
		return ChangeWait{Promise: ch, Cancel: finish}
	}
	s.mu.Lock()
	s.waiters = append(s.waiters, ch)
	s.mu.Unlock()
	if signal != nil {
		done := signal.Done()
		if done != nil {
			go func() {
				<-done
				finish()
			}()
		}
	}
	return ChangeWait{Promise: ch, Cancel: finish}
}

func execMigration(db *sql.DB, script string) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	if _, err := db.Exec(script); err != nil {
		_, _ = db.Exec("ROLLBACK")
		panic(err)
	}
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

const schemaV1 = `
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
`

const schemaV2 = `
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
`

const schemaV3 = `CREATE TABLE questions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  node_id TEXT NOT NULL, operation_id TEXT REFERENCES operations(id), kind TEXT NOT NULL,
  data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', answer TEXT);
  PRAGMA user_version=3;`

const schemaV4 = `CREATE TABLE task_grants(task_id TEXT NOT NULL REFERENCES tasks(id), grant TEXT NOT NULL,
  PRIMARY KEY(task_id,grant)); PRAGMA user_version=4;`

const schemaV5 = `ALTER TABLE nodes ADD COLUMN route TEXT; PRAGMA user_version=5;`

const schemaV6 = `
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
`

const schemaV7 = `
ALTER TABLE nodes ADD COLUMN stall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE graph_revisions ADD COLUMN base_version INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=7;
`

const schemaV8 = `
ALTER TABLE instances ADD COLUMN definition_version TEXT;
ALTER TABLE instances ADD COLUMN model TEXT;
ALTER TABLE instances ADD COLUMN models_used TEXT NOT NULL DEFAULT '[]';
CREATE TABLE definitions(id TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE capabilities(id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, version TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE installations(id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, state TEXT NOT NULL, spec TEXT NOT NULL, result TEXT);
CREATE TABLE invocations(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, instance_id TEXT NOT NULL, model TEXT NOT NULL, usage TEXT, cost TEXT);
CREATE TABLE models(id TEXT PRIMARY KEY, spec TEXT NOT NULL);
PRAGMA user_version=8;
`

const schemaV9 = `
ALTER TABLE tasks ADD COLUMN integration_branch TEXT;
ALTER TABLE tasks ADD COLUMN integration_sha TEXT;
ALTER TABLE tasks ADD COLUMN target_sha TEXT;
ALTER TABLE evidence ADD COLUMN commit_sha TEXT;
CREATE TABLE worktrees(instance_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL);
CREATE TABLE git_ops(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, spec TEXT NOT NULL, result TEXT);
CREATE TABLE git_commits(sha TEXT NOT NULL, task_id TEXT NOT NULL, node_id TEXT, operation_id TEXT, kind TEXT NOT NULL);
PRAGMA user_version=9;
`

const schemaV10 = `ALTER TABLE operations ADD COLUMN waiting_slot INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=10;`

const schemaV11 = `
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
PRAGMA user_version=11;`
