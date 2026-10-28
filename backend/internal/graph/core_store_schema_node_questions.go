package graph

// graph:table-writes-exempt: migrations own schema changes
const schemaV51 = `
CREATE TABLE node_questions (
 id TEXT PRIMARY KEY,
 execution_id TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 node_id TEXT NOT NULL,
 queue_seq INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('recorded','parked','answered')),
 manual_pause INTEGER NOT NULL DEFAULT 0 CHECK(manual_pause IN (0,1)),
 question_id TEXT REFERENCES questions(id),
 UNIQUE(task_id,node_id,request_id)
);
CREATE UNIQUE INDEX node_questions_open_execution ON node_questions(execution_id) WHERE state IN ('recorded','parked');
PRAGMA user_version=51;
`
