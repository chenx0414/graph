package graph

import (
	"os"
	"path"
	"path/filepath"
	"strings"
)

func validateAcceptanceVerification(id string, raw any, nodes map[string]any) {
	invalid := func() {
		interfaceSpecInvalid("Acceptance " + id + " verification requires exact repository-relative paths and failureText")
	}
	record, _ := raw.(map[string]any)
	paths, _ := record["paths"].([]any)
	failureText, _ := record["failureText"].(string)
	for key := range record {
		if key != "paths" && key != "failureText" && key != "implementationNodes" {
			invalid()
		}
	}
	if rawNodes, exists := record["implementationNodes"]; exists {
		list, _ := rawNodes.([]any)
		seen := map[string]bool{}
		if len(list) == 0 {
			interfaceSpecInvalid("Acceptance " + id + " requires named implementation nodes")
		}
		for _, item := range list {
			node, _ := item.(string)
			if nodes[node] == nil || seen[node] {
				interfaceSpecInvalid("Acceptance " + id + " must name distinct implementation nodes in this graph")
			}
			seen[node] = true
		}
	}
	if len(paths) == 0 || len(paths) > 100 ||
		strings.TrimSpace(failureText) == "" || len(failureText) > 500 || strings.ContainsAny(failureText, "\r\n\x00") {
		invalid()
	}
	seen := map[string]bool{}
	for _, rawPath := range paths {
		file, _ := rawPath.(string)
		if file == "" || path.IsAbs(file) || path.Clean(file) != file ||
			file == "." || file == ".." || strings.HasPrefix(file, "../") ||
			strings.ContainsAny(file, "\\:*?[\r\n\x00") || seen[file] {
			invalid()
		}
		seen[file] = true
	}
}

func checkAcceptanceVerification(kernel *KernelStore, task TaskRow, operation *ModuleOperation, attempts []map[string]any, latest map[string]any, result *AcceptanceStatus) {
	result.Baseline = nil
	if task.TargetSha == nil || task.IntegrationBranch == nil || *task.IntegrationBranch == "" {
		result.Status = "missing"
		result.Reason = "Verification requires a prepared Git integration branch"
		return
	}
	project, _ := g5One(kernel.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
	repo := g5Str(project["root"])
	if repo == "" {
		result.Status = "missing"
		result.Reason = "Verification repository is unavailable"
		return
	}
	verification := result.Verification
	baselineReceipt, baselineBeforeLatest := findVerificationBaseline(kernel, repo, verification, operation, attempts, g5Str(latest["id"]))
	result.Baseline = baselineReceipt
	if result.Baseline == nil {
		result.Status = "missing"
		result.Reason = "A clean baseline with only verification-file changes must fail with the expected output"
		return
	}
	if result.Status != "passed" {
		if result.Source != nil && result.Source.Id == result.Baseline.Id {
			result.Reason = "Baseline failed as expected. Run the same check on the implementation commit"
		}
		return
	}
	evaluated, _ := kernel.Content.Decode(g5Str(latest["result"])).(map[string]any)
	if !baselineBeforeLatest || result.Source.Commit == nil ||
		g5Str(evaluated["verificationCommit"]) != *result.Source.Commit {
		result.Status = "stale"
		result.Reason = "Run the same check on the clean integration commit after the failing baseline"
		return
	}
	baseline := *result.Baseline.Commit
	candidate := *result.Source.Commit
	if !verificationGitAncestor(repo, baseline, candidate) ||
		!verificationFilesMatch(repo, baseline, candidate, verification.Paths) {
		result.Status = "stale"
		result.Reason = "The delivery commit must descend from the failing baseline and preserve its verification files"
		return
	}
	result.Reason = "The same check failed on the baseline and passed on the delivery commit"
}

func findVerificationBaseline(kernel *KernelStore, repo string, verification *AcceptanceVerification, operation *ModuleOperation, attempts []map[string]any, latestID string) (*AcceptanceSource, bool) {
	pastLatest := false
	for index := len(attempts) - 1; index >= 0; index-- {
		attempt := attempts[index]
		id := g5Str(attempt["id"])
		if id == latestID {
			pastLatest = true
		}
		verdict, _, decided := graphAcceptanceAttemptVerdict(kernel, attempt, operation.Output)
		if !decided || verdict != "failed" {
			continue
		}
		recorded, _ := kernel.Content.Decode(g5Str(attempt["request"])).(map[string]any)
		if CanonicalJSON(recorded["operation"]) != CanonicalJSON(operation) {
			continue
		}
		evaluated, _ := kernel.Content.Decode(g5Str(attempt["result"])).(map[string]any)
		commit := g5Str(evaluated["verificationCommit"])
		target := g5Str(evaluated["verificationTarget"])
		outputs, _ := evaluated["outputs"].(map[string]any)
		output, _ := outputs[operation.Output].(map[string]any)
		if commit == "" || target == "" || (!strings.Contains(g5Str(output["stdout"]), verification.FailureText) &&
			!strings.Contains(g5Str(output["stderr"]), verification.FailureText)) {
			continue
		}
		if verificationOnlyBaseline(repo, target, commit, verification.Paths) {
			return &AcceptanceSource{Id: id, Commit: &commit}, !pastLatest
		}
	}
	return nil, false
}

func verificationFilesMatch(repo, baseline, candidate string, paths []string) bool {
	entries := func(commit string) gitRun {
		return verificationGit(repo, append([]string{"ls-tree", "--full-tree", "-z", commit, "--"}, paths...)...)
	}
	original, current := entries(baseline), entries(candidate)
	return original.Code == 0 && current.Code == 0 && original.Stdout == current.Stdout
}

func hasStagedVerification(definition GraphDefinition) bool {
	for _, criterion := range definition.Acceptance {
		if criterion.Verification != nil && len(criterion.Verification.ImplementationNodes) != 0 {
			return true
		}
	}
	return false
}

func verificationDispatchBlock(kernel *KernelStore, taskID, nodeID string, definition GraphDefinition) string {
	for _, criterion := range definition.Acceptance {
		spec := criterion.Verification
		if spec == nil || !interfaceSpecContains(spec.ImplementationNodes, nodeID) {
			continue
		}
		reason := "Implementation for " + criterion.Id + " requires a failing baseline whose verification files match the integration commit"
		task := kernel.Store.Task(taskID)
		if task.IntegrationSha == nil {
			return reason
		}
		project, _ := g5One(kernel.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
		repo := g5Str(project["root"])
		operation := definition.Modules[criterion.Module].Operation
		attempts := graphAcceptanceCheckAttempts(kernel, taskID, criterion.Module)
		baseline, _ := findVerificationBaseline(kernel, repo, spec, operation, attempts, "")
		if baseline == nil || !verificationGitAncestor(repo, *baseline.Commit, *task.IntegrationSha) ||
			!verificationFilesMatch(repo, *baseline.Commit, *task.IntegrationSha, spec.Paths) {
			return reason
		}
	}
	return ""
}

func verificationOnlyBaseline(repo, target, baseline string, paths []string) bool {
	if !verificationGitAncestor(repo, target, baseline) {
		return false
	}
	diff := verificationGit(repo, "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", target, baseline, "--")
	if diff.Code != 0 || diff.Stdout == "" {
		return false
	}
	for _, changed := range strings.Split(strings.TrimSuffix(diff.Stdout, "\x00"), "\x00") {
		if !interfaceSpecContains(paths, changed) {
			return false
		}
	}
	tree := verificationGit(repo, append([]string{"ls-tree", "--full-tree", "-z", baseline, "--"}, paths...)...)
	if tree.Code != 0 || strings.Count(tree.Stdout, "\x00") != len(paths) {
		return false
	}
	for _, entry := range strings.Split(strings.TrimSuffix(tree.Stdout, "\x00"), "\x00") {
		if !strings.HasPrefix(entry, "100644 blob ") && !strings.HasPrefix(entry, "100755 blob ") {
			return false
		}
	}
	return true
}

func verificationGitAncestor(repo, ancestor, descendant string) bool {
	return verificationGit(repo, "merge-base", "--is-ancestor", ancestor, descendant).Code == 0
}

func verificationGit(repo string, args ...string) gitRun {
	return GitRaw(repo, append([]string{"--literal-pathspecs"}, args...), nil, map[string]string{"GIT_NO_REPLACE_OBJECTS": "1"})
}

func verificationWorkspaceMatches(workspace, commit string, paths []string) bool {
	for _, file := range paths {
		filename := filepath.Join(workspace, file)
		info, err := os.Lstat(filename)
		if err != nil || !info.Mode().IsRegular() || !PathInside(workspace, filename) {
			return false
		}
		tree := verificationGit(workspace, "ls-tree", "--full-tree", "-z", commit, "--", file)
		description, _, listed := strings.Cut(tree.Stdout, "\t")
		fields := strings.Fields(description)
		if tree.Code != 0 || !listed || len(fields) != 3 || fields[1] != "blob" ||
			(fields[0] == "100755") != (info.Mode().Perm()&0o100 != 0) {
			return false
		}
		hash := verificationGit(workspace, "hash-object", "--no-filters", "--", file)
		if hash.Code != 0 || strings.TrimSpace(hash.Stdout) != fields[2] {
			return false
		}
	}
	return true
}
