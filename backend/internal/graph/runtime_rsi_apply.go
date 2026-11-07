package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (service *RsiService) Apply(input any, context RsiApplyContext) RsiReceipt {
	service.mu.Lock()
	if service.changing {
		service.mu.Unlock()
		Raise("rsi_busy", "Another RSI change is still being validated.")
	}
	service.changing = true
	service.mu.Unlock()
	defer func() {
		service.mu.Lock()
		service.changing = false
		service.mu.Unlock()
	}()
	normalized := RsiChangeInputOf(input)
	return service.rsiApplyChange(normalized, context)
}

func (service *RsiService) rsiApplyChange(input RsiChangeInput, context RsiApplyContext) (receipt RsiReceipt) {
	started := NowMillis()
	stamp := func(value RsiReceipt) RsiReceipt {
		elapsed := NowMillis() - started
		value.ElapsedMs = &elapsed
		return value
	}
	record := func(value RsiReceipt) { service.rsiRecord(context, stamp(value)) }
	defer func() { receipt = stamp(receipt) }()
	title := input.Title
	activate := input.Activate != nil && *input.Activate
	checks := input.Checks
	id := graphUUID()
	root := service.Root
	if !service.Available || root == nil {
		errorText := service.rsiUnavailableReason()
		failure := RsiReceipt{
			Id: id, Status: "unavailable", Title: title, Root: nil, Branch: nil, Commit: nil,
			Files: []string{}, Validation: []RsiValidationResult{}, RestartRequired: false,
			Error: &errorText,
		}
		failure.Report = rsiUnavailableReport(input, nil, errorText)
		record(failure)
		return failure
	}

	paths := []*string{}
	for _, change := range input.Changes {
		inside, ok := rsiInside(*root, change.Path)
		if !ok {
			paths = append(paths, nil)
			continue
		}
		value := inside
		paths = append(paths, &value)
	}
	for _, path := range paths {
		if path == nil || rsiHasGitComponent(*path) {
			Raise("invalid_input", "RSI paths must stay inside the Graph source root and must not target .git")
		}
	}
	uniquePaths := []string{}
	seen := map[string]bool{}
	for _, path := range paths {
		if !seen[*path] {
			seen[*path] = true
			uniquePaths = append(uniquePaths, *path)
		}
	}
	if len(uniquePaths) != len(paths) {
		Raise("invalid_input", "RSI changes must use unique file paths")
	}
	if service.HasPendingRestart() {
		Raise("rsi_reload_pending", "RSI is waiting for reload confirmation. End this turn before starting another improvement.")
	}

	originalHead := RevParse(*root, "HEAD")
	if originalHead == nil {
		Raise("rsi_unavailable", "Graph source checkout has no Git HEAD")
	}
	originalBranch := CheckedOutBranch(*root)
	branch := "rsi/" + rsiSlug(title) + "-" + id[:8]
	if originalBranch != nil && strings.HasPrefix(*originalBranch, "rsi/") {
		branch = *originalBranch
	}

	working := service.rsiReadWorking()
	owned := map[string]bool{}
	ownedOrder := []string{}
	if working != nil && working.Branch == branch {
		for _, path := range working.Paths {
			if !owned[path] {
				owned[path] = true
				ownedOrder = append(ownedOrder, path)
			}
		}
	}
	if len(input.Changes) == 0 && len(checks) == 0 && len(owned) == 0 {
		Raise("invalid_input", "Provide at least one file change or one check to run")
	}
	claimed := map[string]bool{}
	for _, path := range append(append([]string{}, ownedOrder...), uniquePaths...) {
		claimed[path] = true
	}
	blocked := []string{}
	adopted := []string{}
	for _, path := range rsiDirtyPaths(*root) {
		if !claimed[path] {
			blocked = append(blocked, path)
			continue
		}
		if !owned[path] {
			adopted = append(adopted, path)
		}
	}

	service.rsiBeginAttempt(id, title, *root, branch, *originalHead, uniquePaths)
	defer service.rsiClearAttempt()

	createdBranch := false
	if originalBranch == nil || branch != *originalBranch {
		switched := Git(*root, []string{"switch", "-c", branch}, nil, nil)
		if switched.Code != 0 {
			Raise("rsi_git", rsiFirstText(switched.Stderr, "Failed to create "+branch))
		}
		createdBranch = true
	}

	claimedPaths := append(append([]string{}, uniquePaths...), ownedOrder...)
	work := *root
	isolated := false
	isolatedCleanup := func() {}
	if len(blocked) > 0 {
		snapshot, ok, cleanup := rsiIsolatedWorktree(*root, claimedPaths)
		if !ok {
			Raise("rsi_dirty", RsiDirtyMessage(*root, blocked))
		}
		work, isolated, isolatedCleanup = snapshot, true, cleanup
		defer isolatedCleanup()
	}

	snapshotOrder := []string{}
	snapshots := map[string]*string{}
	finalOrder := []string{}
	final := map[string]*string{}

	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		for _, path := range snapshotOrder {
			content := snapshots[path]
			absolute := filepath.Join(work, path)
			if content == nil {
				_ = os.Remove(absolute)
				continue
			}
			_ = os.MkdirAll(filepath.Dir(absolute), 0o700)
			_ = os.WriteFile(absolute, []byte(*content), 0o644)
		}
		touched := []string{}
		touchedSeen := map[string]bool{}
		for _, path := range append(append([]string{}, uniquePaths...), ownedOrder...) {
			if !touchedSeen[path] {
				touchedSeen[path] = true
				touched = append(touched, path)
			}
		}
		if len(touched) > 0 {
			Git(*root, append([]string{"reset", "-q", "--"}, touched...), nil, nil)
		}
		if len(owned) > 0 {
			_ = service.rsiWriteWorking(branch, ownedOrder)
		} else {
			_ = os.Remove(service.rsiWorkingPath())
		}
		if createdBranch && originalBranch != nil && len(owned) == 0 {
			Git(*root, []string{"switch", *originalBranch}, nil, nil)
			Git(*root, []string{"branch", "-D", branch}, nil, nil)
		}
		message := rsiPanicMessage(recovered)
		failure := RsiReceipt{
			Id: id, Status: "rolled_back", Title: title, Root: root, Branch: originalBranch, Commit: nil,
			Files: uniquePaths, Validation: []RsiValidationResult{}, RestartRequired: false,
			Error: &message,
		}
		failure.Report = rsiFailureReport(input, root, message, nil)
		record(failure)
		receipt = failure
	}()

	for changeIndex, change := range input.Changes {
		path, _ := rsiInside(work, change.Path)
		absolute := filepath.Join(work, path)
		existing, known := snapshots[path]
		if !known {
			content, err := os.ReadFile(absolute)
			if err != nil {
				if !os.IsNotExist(err) {
					panic(err)
				}
				existing = nil
			} else {
				value := string(content)
				existing = &value
			}
			snapshots[path] = existing
			snapshotOrder = append(snapshotOrder, path)
		}
		switch change.Action {
		case "write":
			value := rsiChangeContent(*root, change, changeIndex)
			if existing != nil {
				if refusal := rsiWriteShrinkRefusal(path, *existing, value); refusal != "" {
					Raise("rsi_edit_conflict", refusal)
				}
			}
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = &value
		case "copy":
			shown := GitRaw(*root, []string{"show", *change.From + ":" + path}, nil, nil)
			if shown.Code != 0 {
				detail := ""
				if trimmed := strings.TrimSpace(shown.Stderr); trimmed != "" {
					detail = ": " + strings.Split(trimmed, "\n")[0]
				}
				Raise("rsi_edit_conflict", "RSI copy of "+path+" from "+*change.From+" found no such file in that revision"+
					detail+"；检查两边是不是同一个仓库（13-Graph 与 live 检出是同一仓库的链接 worktree，对方的提交直接可见）")
			}
			value := shown.Stdout
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = &value
		case "delete":
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = nil
		default:
			value := rsiReplacedContent(*root, change, changeIndex, path, existing, owned[path])
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = &value
		}
	}

	for _, path := range finalOrder {
		content := final[path]
		absolute := filepath.Join(work, path)
		if content == nil {
			_ = os.Remove(absolute)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			panic(err)
		}
		if err := os.WriteFile(absolute, []byte(*content), 0o644); err != nil {
			panic(err)
		}
	}

	var changedPaths []string
	if service.runningCommit != nil {
		changedPaths = rsiChangedSince(work, *service.runningCommit)
	}
	relevant := append([]string{}, uniquePaths...)
	relevant = append(relevant, ownedOrder...)
	relevant = append(relevant, changedPaths...)
	needsAppBuild := changedPaths == nil || rsiNeedsAppBuild(relevant)
	needsWebBuild := changedPaths == nil || rsiNeedsWebBuild(relevant)
	raw := service.validate(RsiValidateInput{Root: work, Checks: checks, Activate: activate, NeedsAppBuild: needsAppBuild, NeedsWebBuild: needsWebBuild})
	outputPath := service.rsiWriteReportFile(id, raw)
	validation := []RsiValidationResult{}
	for _, item := range raw {
		validation = append(validation, rsiSummarizeValidation(item))
	}
	failed := false
	for _, item := range validation {
		if item.Status == "failed" {
			failed = true
			break
		}
	}
	if input.DryRun {
		for _, path := range snapshotOrder {
			content := snapshots[path]
			absolute := filepath.Join(work, path)
			if content == nil {
				_ = os.Remove(absolute)
				continue
			}
			_ = os.MkdirAll(filepath.Dir(absolute), 0o700)
			_ = os.WriteFile(absolute, []byte(*content), 0o644)
		}
		if createdBranch && originalBranch != nil && len(owned) == 0 {
			Git(*root, []string{"switch", *originalBranch}, nil, nil)
			Git(*root, []string{"branch", "-D", branch}, nil, nil)
		}
		rehearsal := RsiReceipt{
			Id: id, Status: "dry_run", Title: title, Root: root, Commit: nil,
			Files: uniquePaths, Validation: validation, RestartRequired: false,
			OutputPath: &outputPath,
		}
		rehearsal.Report = rsiDryRunReport(input, rehearsal, failed)
		record(rehearsal)
		return rehearsal
	}
	if failed {
		pendingFiles := []string{}
		pendingSeen := map[string]bool{}
		for _, path := range append(append([]string{}, ownedOrder...), uniquePaths...) {
			if !pendingSeen[path] {
				pendingSeen[path] = true
				pendingFiles = append(pendingFiles, path)
			}
		}
		sort.Strings(pendingFiles)
		if isolated {
			rsiCopyPaths(work, *root, pendingFiles)
		}
		_ = service.rsiWriteWorking(branch, pendingFiles)
		failure := RsiReceipt{
			Id: id, Status: "checks_failed", Title: title, Root: root, Branch: &branch, Commit: nil,
			Files: uniquePaths, Validation: validation, RestartRequired: false,
			PendingFiles: pendingFiles, OutputPath: &outputPath,
		}
		failure.Report = rsiChecksFailedReport(input, failure)
		record(failure)
		return failure
	}

	unverified := []string{}
	for _, path := range rsiDirtyPaths(work) {
		if isolated && (path == "node_modules" || strings.HasPrefix(path, "node_modules/")) {
			continue
		}
		if !owned[path] && !seen[path] {
			unverified = append(unverified, path)
		}
	}
	if len(unverified) > 0 {
		Raise("rsi_dirty", RsiDirtyMessage(*root, unverified))
	}

	commitPaths := []string{}
	commitSeen := map[string]bool{}
	for _, path := range append(append([]string{}, uniquePaths...), ownedOrder...) {
		if !commitSeen[path] {
			commitSeen[path] = true
			commitPaths = append(commitPaths, path)
		}
	}
	sort.Strings(commitPaths)
	tracked := map[string]bool{}
	for _, path := range strings.Split(Git(work, append([]string{"ls-files", "--"}, commitPaths...), nil, nil).Stdout, "\n") {
		if path != "" {
			tracked[path] = true
		}
	}
	stagePaths := []string{}
	for _, path := range commitPaths {
		if tracked[path] {
			stagePaths = append(stagePaths, path)
			continue
		}
		if _, err := os.Stat(filepath.Join(work, path)); err == nil {
			stagePaths = append(stagePaths, path)
		}
	}
	commit := RevParse(work, "HEAD")
	committedNow := false
	if len(stagePaths) > 0 {
		staged := Git(work, append([]string{"add", "-A", "--"}, stagePaths...), nil, nil)
		if staged.Code != 0 {
			Raise("rsi_git", rsiFirstText(staged.Stderr, "Failed to stage RSI changes"))
		}
		committed := Git(work, append([]string{"commit", "--no-verify", "-m", "rsi: " + title, "--"}, stagePaths...), nil, nil)
		if committed.Code != 0 {
			Raise("rsi_git", rsiFirstText(committed.Stderr, "Failed to commit RSI changes"))
		}
		commit = RevParse(work, "HEAD")
		if commit == nil {
			Raise("rsi_git", "RSI commit did not produce a HEAD")
		}
		committedNow = true
	}
	if isolated && committedNow && commit != nil {
		rsiLandIsolatedCommit(*root, work, *commit, claimedPaths)
	}
	if isolated && committedNow && needsWebBuild {
		_ = rsiRunCheckWithEnvironmentRetry(*root, RsiCommand{Command: "node", Args: []string{"--run", "build:web"}}, RSI_BUILD_TIMEOUT_MS)
	}
	var appInstall *RsiAppInstall
	if activate && committedNow && needsAppBuild {
		installed := rsiInstallDesktopApp(*root, work)
		appInstall = &installed
	}
	_ = os.Remove(service.rsiWorkingPath())

	live := commit != nil && service.runningCommit != nil && *commit == *service.runningCommit
	restartRequired := activate && !live
	if restartRequired {
		_ = rsiPauseForReload(service, context.Store, context.TaskId)
		generation := rsiRuntimeGeneration(context.Store)
		if err := service.rsiWriteRestart(id, *root, branch, commit, NowMillis(), int(generation), input.Force); err != nil {
			panic(err)
		}
	}
	var diff *string
	if committedNow && commit != nil {
		diff = rsiDiffFor(*root, *commit)
	}
	described := DescribeActivation(RsiActivationInput{Commit: commit, CommittedNow: committedNow, Activate: activate, Live: live})
	applied := RsiReceipt{
		Id: id, Status: "applied", Title: title, Root: root, Branch: &branch, Commit: commit,
		Files: stagePaths, Validation: validation, RestartRequired: restartRequired, AppInstall: appInstall,
		Activation: &RsiReceiptActivation{State: described.State},
		OutputPath: &outputPath, Adopted: adopted,
	}
	if input.Force {
		applied.Force = true
	}
	if diff != nil {
		applied.Diff = diff
	}
	applied.Report = rsiSuccessReport(input, applied, described.Note)
	record(applied)
	return applied
}
