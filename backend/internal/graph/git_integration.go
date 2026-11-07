package graph

import (
	"sync"
)

type ProjectPreparation struct {
	ProjectId     string  `json:"projectId"`
	State         string  `json:"state"`
	RepoRoot      *string `json:"repoRoot"`
	ProjectSubdir *string `json:"projectSubdir"`
	Branch        *string `json:"branch"`
	BaselineSha   *string `json:"baselineSha"`
	Detail        any     `json:"detail"`
	UpdatedAt     int64   `json:"updatedAt"`
}

type gitPreparationFields struct {
	RepoRoot      *string
	ProjectSubdir *string
	Branch        *string
	BaselineSha   *string
	Detail        any
	HasDetail     bool
}

type GitCommitView struct {
	Subject string
	Parents []string
}

type GitWorkspaceCommit struct {
	Repository string
	Worktree   string
	Commit     string
}

type GitDeliverResult struct {
	Status string
	Data   any
}

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

type GitIntegrateInput struct {
	Id         string
	TaskId     string
	NodeId     string
	InstanceId *string
	Kind       string
	Recipe     string
}

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
