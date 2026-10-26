package graph

// graph:table-writes-exempt: a migration owns the SQL of the schema it migrates

import (
	"database/sql"
)

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
