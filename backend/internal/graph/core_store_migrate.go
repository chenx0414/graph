package graph

// graph:table-writes-exempt: a migration owns the SQL of the schema it migrates

import (
	"database/sql"
)

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
	if version < 43 {
		execMigration(db, schemaV43)
	}
	if version < 44 {
		execMigration(db, schemaV44)
	}
	if version < 45 {
		execMigration(db, schemaV45)
	}
	if version < 46 {
		execMigration(db, schemaV46)
	}
	if version < 47 {
		execMigration(db, schemaV47)
	}
	if version < 48 {
		execMigration(db, schemaV48)
	}
	if version < 49 {
		execMigration(db, schemaV49)
	}
	if version < 50 {
		execMigration(db, schemaV50)
	}
	if version < 51 {
		execMigration(db, schemaV51)
	}
	if version < 52 {
		execMigration(db, schemaV52)
	}
	if version < 53 {
		execMigration(db, schemaV53)
	}
	if version < 54 {
		execMigration(db, schemaV54)
	}
	if version < 55 {
		execMigration(db, schemaV55)
	}
	if version < 56 {
		execMigration(db, schemaV56)
	}
	if version < 57 {
		execMigration(db, schemaV57)
	}
	if version < 58 {
		execMigration(db, schemaV58)
	}
	if version < 59 {
		execMigration(db, schemaV59)
	}
	if version < 60 {
		migrateV60(db)
	}
	if version < 61 {
		migrateV61(db)
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

func migrateV60(db *sql.DB) {
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	execSQL(db, schemaV60)
	run := func(query string, args ...any) {
		if _, err := db.Exec(query, args...); err != nil {
			panic(err)
		}
	}
	globalId := ""
	var global sql.NullString
	err := db.QueryRow("SELECT id FROM conversations WHERE role='global' ORDER BY created_seq LIMIT 1").Scan(&global)
	if err == nil {
		globalId = global.String
	} else if err != sql.ErrNoRows {
		panic(err)
	}
	run(`INSERT INTO agents(id,parent_id,kind,role,name,conversation_id,task_id,project_id,workspace,model,created_at,metadata)
		SELECT c.id,
		  CASE WHEN c.role='project' AND ?!='' THEN ? ELSE NULL END,
		  c.role,c.role,c.title,c.id,c.anchor_task_id,c.project_id,
		  COALESCE((SELECT p.root FROM projects p WHERE p.id=COALESCE(c.project_id,c.workspace_project_id)),''),
		  COALESCE((SELECT json_extract(n.spec,'$.model') FROM nodes n WHERE n.task_id=c.anchor_task_id AND n.id='master'),
		    (SELECT i.model FROM nodes n JOIN instances i ON i.id=n.instance_id
		      WHERE n.task_id=c.anchor_task_id AND n.id='master'),''),
		  c.created_at,'{}'
		FROM conversations c
		WHERE c.role IN ('global','project')
		ON CONFLICT(id) DO NOTHING`, globalId, globalId)
	now := NowMillis()
	run(`INSERT INTO agents(id,parent_id,kind,role,name,conversation_id,task_id,node_id,project_id,workspace,model,created_at,metadata)
		SELECT t.id||'/'||n.id,
		  COALESCE((SELECT c.id FROM conversations c WHERE c.id=t.conversation_id
		    AND c.role IN ('global','project')), NULLIF(?,'')),
		  'node',
		  COALESCE(NULLIF(json_extract(n.spec,'$.role'),''),'worker'),
		  n.id,t.conversation_id,t.id,n.id,t.project_id,
		  COALESCE((SELECT p.root FROM projects p WHERE p.id=t.project_id),''),
		  COALESCE(NULLIF(json_extract(n.spec,'$.model'),''),
		    (SELECT i.model FROM instances i WHERE i.id=n.instance_id),''),
		  COALESCE((SELECT MIN(e.created_at) FROM node_entries e
		    WHERE e.task_id=n.task_id AND e.node_id=n.id), ?),
		  '{}'
		FROM nodes n JOIN tasks t ON t.id=n.task_id
		WHERE n.id!='master'
		ON CONFLICT(id) DO NOTHING`, globalId, now)
	if migrationTableExists(db, "kernel_nodes") {
		run(`INSERT INTO agents(id,parent_id,kind,role,name,conversation_id,task_id,node_id,project_id,workspace,model,created_at,metadata)
			SELECT t.id||'/'||k.node_id,
			  COALESCE((SELECT c.id FROM conversations c WHERE c.id=t.conversation_id
			    AND c.role IN ('global','project')), NULLIF(?,'')),
			  'node',
			  COALESCE(NULLIF(json_extract(k.spec,'$.role'),''),'worker'),
			  k.node_id,t.conversation_id,k.task_id,k.node_id,t.project_id,
			  COALESCE((SELECT p.root FROM projects p WHERE p.id=t.project_id),''),
			  COALESCE(NULLIF(json_extract(k.spec,'$.model'),''),''),
			  COALESCE((SELECT MIN(e.created_at) FROM node_entries e
			    WHERE e.task_id=k.task_id AND e.node_id=k.node_id), ?),
			  '{}'
			FROM kernel_nodes k JOIN tasks t ON t.id=k.task_id
			ON CONFLICT(id) DO NOTHING`, globalId, now)
	}
	execSQL(db, "PRAGMA user_version=60;")
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}

func migrationTableExists(db *sql.DB, table string) bool {
	var name string
	err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
	return err == nil
}

func migrateV61(db *sql.DB) {
	if _, err := db.Exec("PRAGMA foreign_keys=OFF"); err != nil {
		panic(err)
	}
	defer func() {
		if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
			panic(err)
		}
	}()
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	defer func() {
		if rec := recover(); rec != nil {
			_, _ = db.Exec("ROLLBACK")
			panic(rec)
		}
	}()
	execSQL(db, schemaV61)
	rows, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		panic(err)
	}
	violations := 0
	for rows.Next() {
		violations++
	}
	if err := rows.Close(); err != nil {
		panic(err)
	}
	if violations > 0 {
		panic("the conversations rebuild broke a foreign key")
	}
	if _, err := db.Exec("COMMIT"); err != nil {
		panic(err)
	}
}
