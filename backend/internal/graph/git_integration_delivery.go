package graph

import (
	"path/filepath"
	"strings"
)

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
		integration.store.SetTaskIntegrationSha(taskId, *head)
	}
	if current.Phase != "running" || current.IntegrationBranch == nil || current.TargetBranch == nil {
		return nil
	}
	targetSha := RevParse(*repo, *current.TargetBranch)
	if targetSha != nil && head != nil && *targetSha == *head {
		graphDBExec(integration.store.Db, "UPDATE git_ops SET state='succeeded' WHERE task_id=? AND kind='deliver' AND state IN ('intent','dispatched')", taskId)
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
