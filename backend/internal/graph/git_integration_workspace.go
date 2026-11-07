package graph

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"encoding/json"
)

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
	KeepNodeWorktree(integration.store, *instanceId, taskId, nodeId, path, branch)
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
