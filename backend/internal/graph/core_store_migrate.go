package graph

import (
	"database/sql"
)

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
