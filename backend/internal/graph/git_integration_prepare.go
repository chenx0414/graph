package graph

import (
	"path/filepath"
	"strings"
	"sync"

	"encoding/json"
)

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
		integration.store.SetTaskIntegration(taskId, branch, sha, *targetSha)
		ReplaceIntegrationWorktree(integration.store, taskId, integrationPath, branch)
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
	AddIntegrationWorktree(integration.store, taskId, path, *task.IntegrationBranch)
}
