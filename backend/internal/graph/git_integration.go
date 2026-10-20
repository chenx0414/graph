package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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

// Exclusive runs actions for one task one at a time. A failed action still releases the next.
func (integration *GitIntegration) Exclusive(taskId string, action func() any) any {
	integration.mu.Lock()
	lock := integration.tails[taskId]
	if lock == nil {
		lock = &sync.Mutex{}
		integration.tails[taskId] = lock
	}
	integration.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	return action()
}

func (integration *GitIntegration) RepoRoot(taskId string) *string {
	task := integration.store.Task(taskId)
	if cached, ok := integration.repos[task.ProjectID]; ok && cached != "" {
		return &cached
	}
	row, ok := graphDBRow(integration.store.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
	if !ok {
		Raise("not_found", "Unknown project "+task.ProjectID)
	}
	root := DetectRepo(graphDBString(row, "root"))
	if root != nil {
		integration.repos[task.ProjectID] = *root
	}
	return root
}

func (integration *GitIntegration) Preparation(projectId string) *ProjectPreparation {
	row, ok := graphDBRow(integration.store.Db, "SELECT * FROM project_preparation WHERE project_id=?", projectId)
	if !ok {
		return nil
	}
	prep := &ProjectPreparation{
		ProjectId: graphDBString(row, "project_id"),
		State:     graphDBString(row, "state"),
		UpdatedAt: graphDBInt(row, "updated_at"),
	}
	prep.RepoRoot = graphDBStringPtr(row, "repo_root")
	prep.ProjectSubdir = graphDBStringPtr(row, "project_subdir")
	prep.Branch = graphDBStringPtr(row, "branch")
	prep.BaselineSha = graphDBStringPtr(row, "baseline_sha")
	if detail := graphDBStringPtr(row, "detail"); detail != nil {
		var parsed any
		if err := json.Unmarshal([]byte(*detail), &parsed); err != nil {
			panic(err)
		}
		prep.Detail = parsed
	}
	return prep
}

// VisiblePaths lists read-only project paths for chat references.
func (integration *GitIntegration) VisiblePaths(projectId, query string, limit int) []ProjectPathEntry {
	if limit == 0 {
		limit = 80
	}
	row, ok := graphDBRow(integration.store.Db, "SELECT root FROM projects WHERE id=?", projectId)
	if !ok {
		Raise("not_found", "Unknown project "+projectId)
	}
	return ProjectPathEntries(graphDBString(row, "root"), projectPathOptions{StateDir: integration.stateDir, Query: query, Limit: limit})
}

func (integration *GitIntegration) recordPreparation(projectId, state string, fields gitPreparationFields) {
	var detail any
	if fields.HasDetail && fields.Detail != nil {
		detail = CanonicalJSON(fields.Detail)
	}
	graphDBExec(integration.store.Db, `INSERT OR REPLACE INTO project_preparation(project_id,state,repo_root,project_subdir,branch,baseline_sha,detail,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
		projectId, state, optionalText(fields.RepoRoot), optionalText(fields.ProjectSubdir), optionalText(fields.Branch),
		optionalText(fields.BaselineSha), detail, NowMillis())
}

// PrepareProject records scoped readiness. A plain directory is initialized only when asked.
func (integration *GitIntegration) PrepareProject(projectId string, initialize, createBaseline bool) *ProjectPreparation {
	row, ok := graphDBRow(integration.store.Db, "SELECT root FROM projects WHERE id=?", projectId)
	if !ok {
		Raise("not_found", "Unknown project "+projectId)
	}
	root := gitReal(graphDBString(row, "root"))
	repo := DetectRepo(root)
	if repo == nil {
		if !initialize {
			integration.recordPreparation(projectId, "detected", gitPreparationFields{HasDetail: true, Detail: map[string]any{"reason": "not_a_repository"}})
			return integration.Preparation(projectId)
		}
		integration.recordPreparation(projectId, "initializing", gitPreparationFields{})
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					reason := panicMessage(rec)
					integration.recordPreparation(projectId, "failed", gitPreparationFields{HasDetail: true, Detail: map[string]any{"reason": reason}})
					Raise("project_prepare_failed", "Failed to initialize Git in "+root+": "+reason)
				}
			}()
			InitRepo(root)
			baseline := CommitBaseline(root, "graph: local baseline", "", integration.stateDir)
			integration.repos[projectId] = root
			branch := CheckedOutBranch(root)
			integration.recordPreparation(projectId, "ready", gitPreparationFields{
				RepoRoot: &root, ProjectSubdir: gitString(""), Branch: branch, BaselineSha: &baseline,
				HasDetail: true,
				Detail: map[string]any{
					"initialized": true, "baselineCreated": true,
					"fingerprint": RepoFingerprint(root, "", integration.stateDir),
				},
			})
		}()
		return integration.Preparation(projectId)
	}
	subdir := gitSubdir(*repo, root)
	integration.repos[projectId] = *repo
	record := func(state string, extra map[string]any) *ProjectPreparation {
		detail := map[string]any{"fingerprint": RepoFingerprint(*repo, subdir, integration.stateDir)}
		for key, value := range extra {
			detail[key] = value
		}
		integration.recordPreparation(projectId, state, gitPreparationFields{
			RepoRoot: repo, ProjectSubdir: &subdir, Branch: CheckedOutBranch(*repo), BaselineSha: RevParse(*repo, "HEAD"),
			HasDetail: true, Detail: detail,
		})
		return integration.Preparation(projectId)
	}
	if !HasHead(*repo) {
		integration.recordPreparation(projectId, "initializing", gitPreparationFields{RepoRoot: repo, ProjectSubdir: &subdir})
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					reason := panicMessage(rec)
					integration.recordPreparation(projectId, "failed", gitPreparationFields{
						RepoRoot: repo, ProjectSubdir: &subdir, HasDetail: true, Detail: map[string]any{"reason": reason},
					})
					Raise("project_prepare_failed", "Failed to create a Git baseline in "+*repo+": "+reason)
				}
			}()
			CommitBaseline(*repo, "graph: local baseline", subdir, integration.stateDir)
		}()
		return record("ready", map[string]any{"initialized": false, "baselineCreated": true})
	}
	dirty := ScopedDirty(*repo, subdir, integration.stateDir)
	if len(dirty) > 0 && createBaseline {
		integration.recordPreparation(projectId, "initializing", gitPreparationFields{RepoRoot: repo, ProjectSubdir: &subdir})
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					reason := panicMessage(rec)
					integration.recordPreparation(projectId, "failed", gitPreparationFields{
						RepoRoot: repo, ProjectSubdir: &subdir, HasDetail: true, Detail: map[string]any{"reason": reason},
					})
					Raise("project_prepare_failed", "Failed to create a Git baseline in "+*repo+": "+reason)
				}
			}()
			CommitBaseline(*repo, "graph: local baseline", subdir, integration.stateDir)
		}()
		sample := dirty
		if len(sample) > 20 {
			sample = sample[:20]
		}
		return record("ready", map[string]any{"dirty": len(dirty), "baselineCreated": true, "sample": sample})
	}
	if len(dirty) > 0 {
		sample := dirty
		if len(sample) > 20 {
			sample = sample[:20]
		}
		return record("detected", map[string]any{"dirty": len(dirty), "sample": sample})
	}
	return record("ready", map[string]any{"dirty": 0})
}

// ProjectHead is the repository HEAD, or nil when the project is not a repository.
func (integration *GitIntegration) ProjectHead(projectId string) *string {
	row, ok := graphDBRow(integration.store.Db, "SELECT root FROM projects WHERE id=?", projectId)
	if !ok {
		return nil
	}
	root := gitReal(graphDBString(row, "root"))
	repo := DetectRepo(root)
	if repo == nil {
		return nil
	}
	return RevParse(*repo, "HEAD")
}

// ProjectFingerprint is the content fingerprint used to replay an interrupted baseline.
func (integration *GitIntegration) ProjectFingerprint(projectId string) *string {
	row, ok := graphDBRow(integration.store.Db, "SELECT root FROM projects WHERE id=?", projectId)
	if !ok {
		return nil
	}
	root := gitReal(graphDBString(row, "root"))
	repo := DetectRepo(root)
	var fingerprint string
	if repo == nil {
		fingerprint = DirectoryFingerprint(root, integration.stateDir)
	} else {
		fingerprint = RepoFingerprint(*repo, gitSubdir(*repo, root), integration.stateDir)
	}
	return &fingerprint
}

// LastCommit is the tip subject and parents, used to recognize a concluded effect.
func (integration *GitIntegration) LastCommit(projectId string) *GitCommitView {
	row, ok := graphDBRow(integration.store.Db, "SELECT root FROM projects WHERE id=?", projectId)
	if !ok {
		return nil
	}
	root := gitReal(graphDBString(row, "root"))
	repo := DetectRepo(root)
	if repo == nil || !HasHead(*repo) {
		return nil
	}
	subject := Git(*repo, []string{"log", "-1", "--format=%s"}, nil, nil).Stdout
	parents := strings.Fields(Git(*repo, []string{"log", "-1", "--format=%P"}, nil, nil).Stdout)
	return &GitCommitView{Subject: subject, Parents: parents}
}

func (integration *GitIntegration) MarkPrepareUnresolved(projectId, reason string) {
	subdir := (*string)(nil)
	if prep := integration.Preparation(projectId); prep != nil {
		subdir = prep.ProjectSubdir
	}
	integration.recordPreparation(projectId, "failed", gitPreparationFields{
		ProjectSubdir: subdir, HasDetail: true, Detail: map[string]any{"reason": reason},
	})
}

func (integration *GitIntegration) refreshPrepared(projectId string) *ProjectPreparation {
	prep := integration.Preparation(projectId)
	if prep == nil || prep.State == "initializing" || prep.State == "failed" {
		return integration.PrepareProject(projectId, true, false)
	}
	if prep.State != "ready" && prep.State != "detected" {
		return prep
	}
	if prep.RepoRoot == nil {
		return integration.PrepareProject(projectId, false, false)
	}
	subdir := ""
	if prep.ProjectSubdir != nil {
		subdir = *prep.ProjectSubdir
	}
	current := RepoFingerprint(*prep.RepoRoot, subdir, integration.stateDir)
	recorded, _ := prep.Detail.(map[string]any)["fingerprint"].(string)
	if recorded == current {
		return prep
	}
	return integration.PrepareProject(projectId, false, false)
}

// RequirePrepared auto-prepares a plain directory and requires a ready project.
func (integration *GitIntegration) RequirePrepared(projectId string) *ProjectPreparation {
	prep := integration.refreshPrepared(projectId)
	if prep.State == "ready" {
		return prep
	}
	reason, _ := prep.Detail.(map[string]any)["reason"].(string)
	if reason == "not_a_repository" {
		Raise("git_required", "Project "+projectId+" is not a Git repository; prepare it from the console first")
	}
	if prep.State == "failed" {
		Raise("project_prepare_failed", "Project "+projectId+" Git preparation failed")
	}
	Raise("project_dirty", "Project "+projectId+" has uncommitted changes; review them and create a local baseline before dispatch")
	return nil
}

// RequireTargetBranch checks readiness and that the target branch exists.
func (integration *GitIntegration) RequireTargetBranch(projectId, branch string) *ProjectPreparation {
	prep := integration.RequirePrepared(projectId)
	if prep.RepoRoot == nil || RevParse(*prep.RepoRoot, branch) == nil {
		Raise("invalid_input", "Unknown target branch "+branch)
	}
	return prep
}

func (integration *GitIntegration) PrepareTask(taskId, targetBranch string) {
	task := integration.store.Task(taskId)
	prep := integration.RequirePrepared(task.ProjectID)
	repo := *prep.RepoRoot
	targetSha := RevParse(repo, targetBranch)
	if targetSha == nil {
		Raise("invalid_input", "Unknown target branch "+targetBranch)
	}
	branch := TaskBranchName(task.Request, taskId)
	integrationPath := filepath.Join(integration.stateDir, "worktrees", TaskWorktreeDirName(task.Request, taskId), "integration")
	EnsureWorktree(repo, integrationPath, branch, *targetSha)
	sha := *targetSha
	if head := RevParse(integrationPath, "HEAD"); head != nil {
		sha = *head
	}
	integration.store.Transaction(func() any {
		graphDBExec(integration.store.Db, "UPDATE tasks SET integration_branch=?,integration_sha=?,target_sha=? WHERE id=?", branch, sha, *targetSha, taskId)
		graphDBExec(integration.store.Db, "INSERT OR REPLACE INTO worktrees VALUES(?,?,?,?,?)", "integration:"+taskId, taskId, "integration", integrationPath, branch)
		integration.store.Event(taskId, "git.prepared", map[string]any{"branch": branch, "targetBranch": targetBranch, "targetSha": *targetSha})
		return nil
	})
}

func (integration *GitIntegration) ensureIntegrationWorkspace(taskId string) {
	task := integration.store.Task(taskId)
	if task.IntegrationBranch == nil || (task.Phase != "running" && task.Phase != "queued") {
		return
	}
	if _, ok := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+taskId); ok {
		return
	}
	repo := integration.RepoRoot(taskId)
	if repo == nil {
		return
	}
	path := filepath.Join(integration.stateDir, "worktrees", TaskWorktreeDirName(task.Request, taskId), "integration")
	var tip *string
	if task.IntegrationSha != nil {
		copy := *task.IntegrationSha
		tip = &copy
	} else {
		tip = RevParse(*repo, *task.IntegrationBranch)
	}
	if tip == nil {
		Raise("invalid_state", "Task integration commit is unavailable")
	}
	EnsureWorktree(*repo, path, *task.IntegrationBranch, *tip)
	graphDBExec(integration.store.Db, "INSERT INTO worktrees VALUES(?,?,?,?,?)", "integration:"+taskId, taskId, "integration", path, *task.IntegrationBranch)
}

// Workspace is the node work copy, or the integration tree for a non-agent lane.
func (integration *GitIntegration) Workspace(taskId string, instanceId *string, nodeId, kind, action string) *string {
	integration.ensureIntegrationWorkspace(taskId)
	task := integration.store.Task(taskId)
	if task.IntegrationBranch == nil {
		return nil
	}
	repo := integration.RepoRoot(taskId)
	if repo == nil {
		return nil
	}
	subdir := ""
	if prep := integration.Preparation(task.ProjectID); prep != nil && prep.ProjectSubdir != nil {
		subdir = *prep.ProjectSubdir
	}
	joinSub := func(path string) string {
		if subdir == "" {
			return path
		}
		return filepath.Join(path, subdir)
	}
	if kind != "agent" || instanceId == nil || *instanceId == "" {
		row, ok := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+taskId)
		if !ok {
			return nil
		}
		path := joinSub(graphDBString(row, "path"))
		return &path
	}
	if existing, ok := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE instance_id=?", *instanceId); ok {
		tree := graphDBString(existing, "path")
		if action != "" && action != "work" {
			var tip *string
			if task.IntegrationSha != nil {
				copy := *task.IntegrationSha
				tip = &copy
			} else {
				tip = RevParse(*repo, *task.IntegrationBranch)
			}
			head := RevParse(tree, "HEAD")
			if tip != nil && (head == nil || *head != *tip) {
				ResetHard(tree, *tip)
				from := any(nil)
				if head != nil {
					from = *head
				}
				integration.store.Event(taskId, "git.workcopy.reseeded", map[string]any{"nodeId": nodeId, "from": from, "to": *tip})
			}
		}
		path := joinSub(tree)
		return &path
	}
	branch := WorkCopyBranchName(task.Request, taskId, nodeId)
	root := filepath.Join(integration.stateDir, "worktrees", TaskWorktreeDirName(task.Request, taskId))
	taken := []string{}
	for _, row := range graphDBAll(integration.store.Db, "SELECT path FROM worktrees WHERE task_id=?", taskId) {
		taken = append(taken, filepath.Base(graphDBString(row, "path")))
	}
	if entries, err := os.ReadDir(root); err == nil {
		for _, entry := range entries {
			taken = append(taken, entry.Name())
		}
	}
	path := filepath.Join(root, UniqueWorktreeDirName(nodeId, taken))
	var start string
	if task.IntegrationSha != nil {
		start = *task.IntegrationSha
	} else if tip := RevParse(*repo, *task.IntegrationBranch); tip != nil {
		start = *tip
	}
	EnsureWorktree(*repo, path, branch, start)
	graphDBExec(integration.store.Db, "INSERT OR IGNORE INTO worktrees VALUES(?,?,?,?,?)", *instanceId, taskId, nodeId, path, branch)
	joined := joinSub(path)
	return &joined
}

var gitIdentityVersion = regexp.MustCompile(`^(.*)@(\d+)$`)
var gitIdentitySlug = regexp.MustCompile(`[^a-z0-9]+`)

func (integration *GitIntegration) agentIdentity(nodeId, recipe string) *GitIdentity {
	definitionVersion := recipe
	if definitionVersion == "" {
		definitionVersion = nodeId
	}
	definitionId := strings.Split(definitionVersion, "@")[0]
	if definitionId == "" {
		definitionId = nodeId
	}
	name := definitionId
	if version := gitIdentityVersion.FindStringSubmatch(definitionVersion); version != nil {
		if row, ok := graphDBRow(integration.store.Db, "SELECT spec FROM definitions WHERE id=? AND version=?", version[1], version[2]); ok {
			var spec map[string]any
			if err := json.Unmarshal([]byte(graphDBString(row, "spec")), &spec); err == nil {
				snapshot, _ := spec["snapshot"].(map[string]any)
				candidate, _ := snapshot["name"].(string)
				if combination, ok := snapshot["agentCombination"].(map[string]any); ok {
					if named, ok := combination["name"].(string); ok {
						candidate = named
					}
				}
				if strings.TrimSpace(candidate) != "" {
					name = strings.TrimSpace(candidate)
				}
			}
		}
	}
	slug := strings.Trim(gitIdentitySlug.ReplaceAllString(strings.ToLower(definitionId), "-"), "-")
	if slug == "" {
		slug = "agent"
	}
	return &GitIdentity{Name: name, Email: slug + "@agents.graph.local"}
}

// CommitWorkspace publishes a stable code version before workflow submit.
func (integration *GitIntegration) CommitWorkspace(input GitCommitInput) GitWorkspaceCommit {
	if len(input.Paths) == 0 || len(input.Paths) > 256 || strings.TrimSpace(input.Message) == "" || len(input.Message) > 4096 {
		Raise("invalid_input", "Commit requires 1–256 paths and a bounded message")
	}
	for _, path := range input.Paths {
		if path == "" || len(path) > 4096 || strings.ContainsAny(path, "\\\x00\r\n") || strings.HasPrefix(path, "/") {
			Raise("permission", "Commit paths must remain inside this node workspace")
		}
		for _, part := range strings.Split(path, "/") {
			if part == "" || part == ".." || part == ".git" {
				Raise("permission", "Commit paths must remain inside this node workspace")
			}
		}
	}
	tree, ok := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE task_id=? AND instance_id=?", input.TaskId, input.InstanceId)
	if !ok || !PathInside(gitReal(graphDBString(tree, "path")), gitReal(input.Workspace)) {
		Raise("permission", "Commit requires the admitted node worktree")
	}
	identity := integration.agentIdentity(input.NodeId, input.Recipe)
	args := append([]string{"--literal-pathspecs", "add", "--"}, input.Paths...)
	added := Git(input.Workspace, args, nil, identity)
	if added.Code != 0 {
		text := added.Stderr
		if text == "" {
			text = "Unable to stage requested files"
		}
		Raise("git_error", text)
	}
	changed := Git(input.Workspace, append([]string{"--literal-pathspecs", "diff", "--quiet", "HEAD", "--"}, input.Paths...), nil, nil)
	if changed.Code != 0 && changed.Code != 1 {
		text := changed.Stderr
		if text == "" {
			text = "Unable to inspect requested files"
		}
		Raise("git_error", text)
	}
	if changed.Code == 1 {
		committed := Git(input.Workspace, append([]string{"--literal-pathspecs", "commit", "--only", "--no-verify", "-m", input.Message, "--"}, input.Paths...), nil, identity)
		if committed.Code != 0 {
			text := committed.Stderr
			if text == "" {
				text = "Unable to commit requested files"
			}
			Raise("git_error", text)
		}
	}
	commit := RevParse(input.Workspace, "HEAD")
	if commit == nil {
		Raise("git_error", "Committed version is unavailable")
	}
	if changed.Code == 1 {
		graphDBExec(integration.store.Db, "INSERT INTO git_commits VALUES(?,?,?,?,?)", *commit, input.TaskId, input.NodeId, input.Id, "instance")
	}
	integration.store.Event(input.TaskId, "git.workspace.committed", map[string]any{
		"executionId": input.Id, "nodeId": input.NodeId, "commit": *commit, "paths": input.Paths, "created": changed.Code == 1,
	})
	return GitWorkspaceCommit{Repository: input.Workspace, Worktree: input.Workspace, Commit: *commit}
}

// Integrate merges an agent work copy into the integration branch.
func (integration *GitIntegration) Integrate(operation GitIntegrateInput) *GitMergeResult {
	if operation.InstanceId == nil || *operation.InstanceId == "" || operation.Kind != "agent" {
		return nil
	}
	task := integration.store.Task(operation.TaskId)
	if task.IntegrationBranch == nil {
		return nil
	}
	tree, ok := graphDBRow(integration.store.Db, "SELECT path,branch FROM worktrees WHERE instance_id=?", *operation.InstanceId)
	integrationRow, haveIntegration := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+operation.TaskId)
	if !ok || !haveIntegration {
		return nil
	}
	identity := integration.agentIdentity(operation.NodeId, operation.Recipe)
	if sha := CommitAll(graphDBString(tree, "path"), "graph:"+operation.NodeId+":"+operation.Id, identity); sha != nil {
		graphDBExec(integration.store.Db, "INSERT INTO git_commits VALUES(?,?,?,?,?)", *sha, operation.TaskId, operation.NodeId, operation.Id, "instance")
	}
	merged := MergeRef(graphDBString(integrationRow, "path"), graphDBString(tree, "branch"))
	if !merged.Ok {
		return &merged
	}
	integration.store.Transaction(func() any {
		graphDBExec(integration.store.Db, "UPDATE tasks SET integration_sha=? WHERE id=?", merged.Sha, operation.TaskId)
		graphDBExec(integration.store.Db, "INSERT INTO git_commits VALUES(?,?,?,?,?)", merged.Sha, operation.TaskId, operation.NodeId, operation.Id, "integration")
		return nil
	})
	return &merged
}

// TryDeliver fast-forwards the target branch to the verified integration commit.
func (integration *GitIntegration) TryDeliver(taskId string, expectedCommit *string) GitDeliverResult {
	task := integration.store.Task(taskId)
	if task.IntegrationBranch == nil || task.TargetBranch == nil {
		return GitDeliverResult{Status: "skip"}
	}
	repo := integration.RepoRoot(taskId)
	if repo == nil {
		return GitDeliverResult{Status: "skip"}
	}
	integrationRow, ok := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+taskId)
	if !ok {
		return GitDeliverResult{Status: "blocked", Data: map[string]any{"reason": "Missing integration worktree"}}
	}
	integrationPath := graphDBString(integrationRow, "path")
	integrationSha := RevParse(integrationPath, "HEAD")
	targetSha := RevParse(*repo, *task.TargetBranch)
	if integrationSha == nil || targetSha == nil {
		return GitDeliverResult{Status: "blocked", Data: map[string]any{"reason": "Missing git refs"}}
	}
	if expectedCommit != nil && (*integrationSha != *expectedCommit || !IsClean(integrationPath, nil)) {
		return GitDeliverResult{Status: "blocked", Data: map[string]any{
			"kind": "stale_acceptance", "reason": "Integration no longer matches the verified clean commit",
			"expectedCommit": *expectedCommit, "integrationSha": *integrationSha,
		}}
	}
	if *targetSha == *integrationSha {
		graphDBExec(integration.store.Db, "UPDATE tasks SET target_sha=? WHERE id=?", *integrationSha, taskId)
		return GitDeliverResult{Status: "merged"}
	}
	if task.TargetSha != nil && *targetSha != *task.TargetSha {
		return integration.recheckAgainstTarget(taskId, integrationPath, *task.TargetBranch, *targetSha)
	}
	opId := graphUUID()
	graphDBExec(integration.store.Db, "INSERT INTO git_ops VALUES(?,?,?,?,?,?)", opId, taskId, "deliver", "dispatched", CanonicalJSON(map[string]any{"integrationSha": *integrationSha, "targetSha": *targetSha}), nil)
	checkouts := []gitWorktree{}
	for _, tree := range WorktreeList(*repo) {
		if tree.Branch == *task.TargetBranch {
			checkouts = append(checkouts, tree)
		}
	}
	if len(checkouts) > 0 {
		for _, target := range checkouts {
			ignore := []string{}
			if PathInside(target.Path, integration.stateDir) {
				ignore = []string{integration.stateDir}
			}
			if !IsClean(target.Path, ignore) {
				graphDBExec(integration.store.Db, "UPDATE git_ops SET state='blocked',result=? WHERE id=?", CanonicalJSON(map[string]any{"kind": "git_dirty"}), opId)
				return GitDeliverResult{Status: "blocked", Data: map[string]any{"kind": "git_dirty", "reason": "Target worktree is dirty"}}
			}
		}
		for _, target := range checkouts {
			forwarded := FastForwardCheckout(target.Path, *integrationSha)
			if !forwarded.Ok {
				graphDBExec(integration.store.Db, "UPDATE git_ops SET state='failed',result=? WHERE id=?", CanonicalJSON(map[string]any{"stderr": forwarded.Stderr}), opId)
				next := *targetSha
				if moved := RevParse(*repo, *task.TargetBranch); moved != nil {
					next = *moved
				}
				return integration.recheckAgainstTarget(taskId, integrationPath, *task.TargetBranch, next)
			}
		}
	} else {
		updated := UpdateRef(*repo, "refs/heads/"+*task.TargetBranch, *integrationSha, *targetSha)
		if !updated.Ok {
			graphDBExec(integration.store.Db, "UPDATE git_ops SET state='failed',result=? WHERE id=?", CanonicalJSON(map[string]any{"stderr": updated.Stderr}), opId)
			next := *targetSha
			if moved := RevParse(*repo, *task.TargetBranch); moved != nil {
				next = *moved
			}
			return integration.recheckAgainstTarget(taskId, integrationPath, *task.TargetBranch, next)
		}
	}
	integration.store.Transaction(func() any {
		graphDBExec(integration.store.Db, "UPDATE tasks SET target_sha=? WHERE id=?", *integrationSha, taskId)
		graphDBExec(integration.store.Db, "UPDATE git_ops SET state='succeeded',result=? WHERE id=?", CanonicalJSON(map[string]any{"sha": *integrationSha}), opId)
		return nil
	})
	return GitDeliverResult{Status: "merged"}
}

// Restore rebuilds the integration worktree for a running task.
func (integration *GitIntegration) Restore(taskId string) *GitDeliverResult {
	task := integration.store.Task(taskId)
	if task.TargetBranch == nil || (task.Phase != "running" && task.Phase != "queued") {
		return nil
	}
	if task.IntegrationBranch == nil {
		integration.PrepareTask(taskId, *task.TargetBranch)
	}
	integration.ensureIntegrationWorkspace(taskId)
	repo := integration.RepoRoot(taskId)
	if repo == nil {
		return nil
	}
	var head *string
	if row, ok := graphDBRow(integration.store.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+taskId); ok {
		path := graphDBString(row, "path")
		AbortMerge(path)
		head = RevParse(path, "HEAD")
	}
	current := integration.store.Task(taskId)
	if head != nil && current.IntegrationSha != nil && *head != *current.IntegrationSha {
		graphDBExec(integration.store.Db, "UPDATE tasks SET integration_sha=? WHERE id=?", *head, taskId)
	}
	if current.Phase != "running" || current.IntegrationBranch == nil || current.TargetBranch == nil {
		return nil
	}
	targetSha := RevParse(*repo, *current.TargetBranch)
	if targetSha != nil && head != nil && *targetSha == *head {
		graphDBExec(integration.store.Db, "UPDATE git_ops SET state='succeeded' WHERE task_id=? AND kind='deliver' AND state IN ('intent','dispatched')", taskId)
		graphDBExec(integration.store.Db, "UPDATE tasks SET target_sha=? WHERE id=?", *head, taskId)
		return &GitDeliverResult{Status: "merged"}
	}
	return nil
}

func (integration *GitIntegration) recheckAgainstTarget(taskId, integrationPath, targetBranch, targetSha string) GitDeliverResult {
	moved := MergeRef(integrationPath, targetBranch)
	if !moved.Ok {
		return GitDeliverResult{Status: "blocked", Data: map[string]any{"kind": "git_conflict", "conflicts": moved.Conflicts, "reason": "Target branch changed"}}
	}
	integration.store.Transaction(func() any {
		graphDBExec(integration.store.Db, "UPDATE tasks SET integration_sha=?,target_sha=? WHERE id=?", moved.Sha, targetSha, taskId)
		return nil
	})
	return GitDeliverResult{Status: "recheck"}
}

// ReleaseWorkcopies drops scratch checkouts. The integration branch stays.
func (integration *GitIntegration) ReleaseWorkcopies(taskId string) int {
	rows := graphDBAll(integration.store.Db, "SELECT instance_id,path,branch FROM worktrees WHERE task_id=?", taskId)
	if len(rows) == 0 {
		return 0
	}
	repo := integration.RepoRoot(taskId)
	if repo == nil {
		return 0
	}
	removed := 0
	for _, row := range rows {
		path := graphDBString(row, "path")
		if path != "" && Git(*repo, []string{"worktree", "remove", "--force", path}, nil, nil).Code == 0 {
			removed++
		}
		branch := graphDBString(row, "branch")
		if strings.HasPrefix(branch, "graph/copy/") {
			Git(*repo, []string{"branch", "-D", branch}, nil, nil)
		}
	}
	Git(*repo, []string{"worktree", "prune"}, nil, nil)
	graphDBExec(integration.store.Db, "DELETE FROM worktrees WHERE task_id=?", taskId)
	integration.store.Event(taskId, "git.workcopies.released", map[string]any{"registered": len(rows), "removed": removed})
	return len(rows)
}

// SweepTerminalWorkcopies releases copies for tasks that already ended.
func (integration *GitIntegration) SweepTerminalWorkcopies() int {
	rows := graphDBAll(integration.store.Db, `SELECT DISTINCT w.task_id FROM worktrees w JOIN tasks t ON t.id=w.task_id
      WHERE t.phase IN ('completed','abandoned')`)
	for _, row := range rows {
		integration.ReleaseWorkcopies(graphDBString(row, "task_id"))
	}
	return len(rows)
}

func optionalText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func gitString(value string) *string {
	return &value
}

func gitSubdir(repo, root string) string {
	rel, err := filepath.Rel(repo, root)
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}
