package graph

import (
	"strings"
)

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
		integration.store.SetTaskIntegrationSha(operation.TaskId, merged.Sha)
		graphDBExec(integration.store.Db, "INSERT INTO git_commits VALUES(?,?,?,?,?)", merged.Sha, operation.TaskId, operation.NodeId, operation.Id, "integration")
		return nil
	})
	return &merged
}

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
		integration.store.SetTaskTargetSha(taskId, *integrationSha)
		return GitDeliverResult{Status: "merged"}
	}
	if task.TargetSha != nil && *targetSha != *task.TargetSha {
		return integration.recheckAgainstTarget(taskId, integrationPath, *task.TargetBranch, *targetSha)
	}
	opId := graphUUID()
	RecordGitOperation(integration.store, opId, taskId, "deliver", "dispatched", CanonicalJSON(map[string]any{"integrationSha": *integrationSha, "targetSha": *targetSha}))
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
				SettleGitOperation(integration.store, opId, "blocked", CanonicalJSON(map[string]any{"kind": "git_dirty"}))
				return GitDeliverResult{Status: "blocked", Data: map[string]any{"kind": "git_dirty", "reason": "Target worktree is dirty"}}
			}
		}
		for _, target := range checkouts {
			forwarded := FastForwardCheckout(target.Path, *integrationSha)
			if !forwarded.Ok {
				SettleGitOperation(integration.store, opId, "failed", CanonicalJSON(map[string]any{"stderr": forwarded.Stderr}))
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
			SettleGitOperation(integration.store, opId, "failed", CanonicalJSON(map[string]any{"stderr": updated.Stderr}))
			next := *targetSha
			if moved := RevParse(*repo, *task.TargetBranch); moved != nil {
				next = *moved
			}
			return integration.recheckAgainstTarget(taskId, integrationPath, *task.TargetBranch, next)
		}
	}
	integration.store.Transaction(func() any {
		integration.store.SetTaskTargetSha(taskId, *integrationSha)
		SettleGitOperation(integration.store, opId, "succeeded", CanonicalJSON(map[string]any{"sha": *integrationSha}))
		return nil
	})
	return GitDeliverResult{Status: "merged"}
}
