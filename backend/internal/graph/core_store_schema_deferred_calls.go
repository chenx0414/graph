package graph

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
