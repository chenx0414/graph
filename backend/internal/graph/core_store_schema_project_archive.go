package graph

// graph:table-writes-exempt: migrations own schema changes

const schemaV47 = `
ALTER TABLE projects ADD COLUMN archived_at INTEGER;
PRAGMA user_version=47;
`

const schemaV48 = `
CREATE TABLE project_archive_pauses (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id)
);
PRAGMA user_version=48;
`

const schemaV49 = `
CREATE TABLE graph_preparation_pauses (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id)
);
PRAGMA user_version=49;
`
