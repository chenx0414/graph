package graph

// graph:table-writes-exempt: migrations own schema changes

const schemaV46 = `
CREATE TABLE work_graphs (
  work_id TEXT NOT NULL REFERENCES work_requests(id),
  graph_key TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  draft_version INTEGER NOT NULL,
  draft_revision INTEGER NOT NULL,
  target_branch TEXT,
  proposal TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  owner_task_id TEXT NOT NULL REFERENCES tasks(id),
  kernel_request_id TEXT NOT NULL UNIQUE,
  graph_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','blocked')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(work_id,graph_key),
  FOREIGN KEY(work_id,work_revision) REFERENCES work_request_revisions(work_id,revision),
  FOREIGN KEY(work_id,draft_version) REFERENCES work_drafts(work_id,version)
);
PRAGMA user_version=46;
`
