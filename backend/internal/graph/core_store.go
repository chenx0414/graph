package graph

import (
	"database/sql"
	"sync"
)

// SCHEMA_VERSION is the newest tasks.sqlite this process writes.
const SCHEMA_VERSION = 54

// SchemaVersion is the same constant. Call sites used both spellings.
const SchemaVersion = SCHEMA_VERSION

// ToolCallRetentionDays is how long a recorded tool call stays in the aggregate.
const ToolCallRetentionDays = 90

// TaskRow is one tasks table row. JSON names are the SQL columns so asMap can read them.
type TaskRow struct {
	ID                 string  `json:"id"`
	ProjectID          string  `json:"project_id"`
	Request            string  `json:"request"`
	RequirementVersion int64   `json:"requirement_version"`
	LatestProposal     int64   `json:"latest_proposal"`
	AcceptedProposal   *int64  `json:"accepted_proposal"`
	TargetBranch       *string `json:"target_branch"`
	Phase              string  `json:"phase"`
	Paused             int64   `json:"paused"`
	CreatedSeq         int64   `json:"created_seq"`
	GraphVersion       int64   `json:"graph_version"`
	IntegrationBranch  *string `json:"integration_branch"`
	IntegrationSha     *string `json:"integration_sha"`
	TargetSha          *string `json:"target_sha"`
	ConversationID     *string `json:"conversation_id"`
	DecisionDigest     *string `json:"decision_digest"`
}

// TaskStore is the durable task database. DB and Db name the same connection;
// translators spelled the field both ways.
type TaskStore struct {
	DB        *sql.DB
	Db        *sql.DB
	Path      string
	mu        sync.Mutex
	listeners []func(string)
	waiters   []chan struct{}
	txDepth   int
	// txMu serializes transactions. The TypeScript host runs one event loop
	// with synchronous SQLite calls, so two transactions never interleave
	// there. The Go host serves the Pi worker protocol on its own goroutine,
	// so the same guarantee is made here: only one transaction is open.
	txMu sync.Mutex
}

func NewTaskStore(db *sql.DB, path string) *TaskStore {
	if _, err := db.Exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"); err != nil {
		panic(err)
	}
	MigrateTaskSchema(db)
	return &TaskStore{DB: db, Db: db, Path: path}
}

func OpenTaskStore(path string) *TaskStore {
	return NewTaskStore(MustOpenSQLite(path), path)
}

func (s *TaskStore) Close() {
	if s == nil || s.DB == nil {
		return
	}
	if err := s.DB.Close(); err != nil {
		panic(err)
	}
	s.emitChange()
}
