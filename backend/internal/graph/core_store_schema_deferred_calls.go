package graph

// schemaV56 records the tool calls that outlive the turn that started them.
//
// A deferred call is one row: the admission facts (which conversation, node
// and execution dispatched it), the identity the model and the console know
// it by (tool_call_id), the idempotency key (request_id + request_digest) and
// the terminal state the one writer settles it with. The row is the record of
// the call, so a process that dies before the job finished still says what
// happened to it: the startup reconcile turns every row this process has no
// job for into `interrupted` instead of leaving it "running" for ever.
//
// conversation_id is nullable because a graph node's session has no
// conversation row; its calls are still tracked (and still settled), they
// simply have no transcript to update. The two unique keys the design names
// therefore do not apply to those rows - SQLite treats NULLs as distinct - so
// a third key covers them.
const schemaV56 = `
        CREATE TABLE IF NOT EXISTS deferred_tool_calls(
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          conversation_id TEXT,
          node_id         TEXT NOT NULL,
          execution_id    TEXT NOT NULL,
          operation_id    TEXT NOT NULL,
          tool_call_id    TEXT NOT NULL,
          tool_name       TEXT NOT NULL,
          request_id      TEXT NOT NULL,
          request_digest  TEXT NOT NULL,
          state           TEXT NOT NULL CHECK(state IN
                            ('accepted','running','settled','failed','cancelled','timed_out','interrupted')),
          args TEXT, summary TEXT, result TEXT, reason TEXT,
          started_at INTEGER NOT NULL, deadline_at INTEGER, finished_at INTEGER,
          UNIQUE(conversation_id, tool_call_id),
          UNIQUE(conversation_id, request_id));
        CREATE UNIQUE INDEX IF NOT EXISTS deferred_tool_calls_call
          ON deferred_tool_calls(task_id, node_id, tool_call_id);
        CREATE INDEX IF NOT EXISTS deferred_tool_calls_live
          ON deferred_tool_calls(state, deadline_at);
        PRAGMA user_version=56;`
