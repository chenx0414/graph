package graph

import (
	"database/sql"
	"sync"
)

const SCHEMA_VERSION = 64

const SchemaVersion = SCHEMA_VERSION

const ToolCallRetentionDays = 90

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

type TaskStore struct {
	DB                *sql.DB
	Db                *sql.DB
	Path              string
	mu                sync.Mutex
	listeners         []func(string)
	waiters           []chan struct{}
	txDepth           int
	txMu              sync.Mutex
	agentExecutions   *executionSlotPool
	programExecutions *executionSlotPool
}

func NewTaskStore(db *sql.DB, path string) *TaskStore {
	if _, err := db.Exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"); err != nil {
		panic(err)
	}
	MigrateTaskSchema(db)
	kernelExec(db, taskInvocationTotalsDDL)
	store := &TaskStore{DB: db, Db: db, Path: path}
	store.agentExecutions = newExecutionSlotPool(DefaultAgentExecutions)
	store.programExecutions = newExecutionSlotPool(DefaultProgramExecutions)
	return store
}

func (s *TaskStore) Close() {
	if s == nil || s.DB == nil {
		return
	}
	fleetSnapshotsForget(s)
	if err := s.DB.Close(); err != nil {
		panic(err)
	}
	s.emitChange()
}
