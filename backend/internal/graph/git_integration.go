package graph

import (
	"sync"
)

// ProjectPreparation is the recorded Git readiness of one project.
type ProjectPreparation struct {
	ProjectId     string
	State         string
	RepoRoot      *string
	ProjectSubdir *string
	Branch        *string
	BaselineSha   *string
	Detail        any
	UpdatedAt     int64
}

type gitPreparationFields struct {
	RepoRoot      *string
	ProjectSubdir *string
	Branch        *string
	BaselineSha   *string
	Detail        any
	HasDetail     bool
}

// GitCommitView is the tip commit subject and parent list.
type GitCommitView struct {
	Subject string
	Parents []string
}

// GitWorkspaceCommit is one published node commit.
type GitWorkspaceCommit struct {
	Repository string
	Worktree   string
	Commit     string
}

// GitDeliverResult is a target-branch delivery attempt.
type GitDeliverResult struct {
	Status string
	Data   any
}

// GitCommitInput is one agent commit of named workspace paths.
type GitCommitInput struct {
	Id         string
	TaskId     string
	NodeId     string
	InstanceId string
	Recipe     string
	Workspace  string
	Paths      []string
	Message    string
}

// GitIntegrateInput is one work-copy merge into the integration branch.
type GitIntegrateInput struct {
	Id         string
	TaskId     string
	NodeId     string
	InstanceId *string
	Kind       string
	Recipe     string
}

// GitIntegration owns the task integration branch and per-instance work copies.
// Git effects stay outside SQLite transactions.
type GitIntegration struct {
	store    *TaskStore
	stateDir string
	mu       sync.Mutex
	repos    map[string]string
	tails    map[string]*sync.Mutex
}

func NewGitIntegration(store *TaskStore, stateDir string) *GitIntegration {
	return &GitIntegration{
		store: store, stateDir: stateDir,
		repos: map[string]string{}, tails: map[string]*sync.Mutex{},
	}
}
