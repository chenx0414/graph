package graph

// graph:table-writes-exempt: migrations own schema changes

const schemaV43 = `
ALTER TABLE conversations ADD COLUMN role TEXT NOT NULL DEFAULT 'legacy'
  CHECK(role IN ('legacy','global','project','history'));
CREATE UNIQUE INDEX conversations_one_global ON conversations(role) WHERE role='global';
CREATE UNIQUE INDEX conversations_one_project ON conversations(project_id) WHERE role='project';
CREATE TRIGGER conversations_role_insert BEFORE INSERT ON conversations
WHEN (NEW.role='global' AND NEW.project_id IS NOT NULL)
  OR (NEW.role='project' AND NEW.project_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Invalid supervisor project binding'); END;
CREATE TRIGGER conversations_role_update BEFORE UPDATE OF role,project_id ON conversations
WHEN (NEW.role='global' AND NEW.project_id IS NOT NULL)
  OR (NEW.role='project' AND NEW.project_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Invalid supervisor project binding'); END;
PRAGMA user_version=43;
`

const schemaV44 = `
CREATE TABLE work_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  project_id TEXT REFERENCES projects(id),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('clarifying','ready','dispatched','completed','cancelled')),
  execution_paused INTEGER NOT NULL DEFAULT 0 CHECK(execution_paused IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX work_requests_project ON work_requests(project_id,created_at);
CREATE TABLE work_request_revisions (
  work_id TEXT NOT NULL REFERENCES work_requests(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  brief TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  acceptance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(work_id,revision)
);
PRAGMA user_version=44;
`
