package graph

// graph:table-writes-exempt: migrations own schema changes

const schemaV45 = `
CREATE TABLE work_drafts (
  work_id TEXT NOT NULL REFERENCES work_requests(id),
  version INTEGER NOT NULL CHECK(version > 0),
  work_revision INTEGER NOT NULL CHECK(work_revision > 0),
  draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
  spec TEXT NOT NULL,
  digest TEXT NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(work_id,version),
  FOREIGN KEY(work_id,work_revision) REFERENCES work_request_revisions(work_id,revision)
);
PRAGMA user_version=45;
`
