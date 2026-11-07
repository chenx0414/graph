package graph

import (
	"path/filepath"
	"strings"

	"encoding/json"
)

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
		integration.store.SetTaskIntegrationSha(taskId, *head)
	}
	if current.Phase != "running" || current.IntegrationBranch == nil || current.TargetBranch == nil {
		return nil
	}
	targetSha := RevParse(*repo, *current.TargetBranch)
	if targetSha != nil && head != nil && *targetSha == *head {
		SettleGitDeliveries(integration.store, taskId)
		integration.store.SetTaskTargetSha(taskId, *head)
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
		integration.store.SetTaskIntegrationAndTarget(taskId, moved.Sha, targetSha)
		return nil
	})
	return GitDeliverResult{Status: "recheck"}
}

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
	ReleaseWorktrees(integration.store, taskId)
	integration.store.Event(taskId, "git.workcopies.released", map[string]any{"registered": len(rows), "removed": removed})
	return len(rows)
}

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

func deliveredCommitOf(store *TaskStore, taskId string) *string {
	row := kernelRow(store.Db, `SELECT value FROM kernel_deliveries WHERE task_id=? AND value LIKE '%"commit"%' ORDER BY created_at DESC, rowid DESC LIMIT 1`, taskId)
	if row == nil {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(kernelString(row["value"])), &value); err != nil {
		return nil
	}
	commit, _ := value["commit"].(string)
	commit = strings.TrimSpace(commit)
	if commit == "" {
		return nil
	}
	return &commit
}

func SyncIntegrationSha(kernel *KernelStore, taskId string) any {
	store := kernel.Store
	var head *string
	row, ok := graphDBRow(store.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+taskId)
	if !ok {
		head = deliveredCommitOf(store, taskId)
		if head == nil {
			Raise("invalid_state", "The graph has no integration worktree to read a commit from, and no delivered commit to record; deliver through the integration branch first")
		}
	} else {
		head = RevParse(graphDBString(row, "path"), "HEAD")
		if head == nil {
			Raise("invalid_state", "The integration worktree has no readable HEAD")
		}
	}
	task := store.Task(taskId)
	before := ""
	if task.IntegrationSha != nil {
		before = *task.IntegrationSha
	}
	if before != *head {
		store.SetTaskIntegrationSha(taskId, *head)
	}
	kernel.Store.Event(taskId, "graph.integration.synced", map[string]any{"before": before, "after": *head})
	return map[string]any{"integrationSha": *head, "changed": before != *head, "before": before}
}
