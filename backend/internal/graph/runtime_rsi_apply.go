package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Apply validates and applies one self-improvement change.
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

// rsiApplyChange writes the files, runs the gate and commits.
func (service *RsiService) rsiApplyChange(input RsiChangeInput, context RsiApplyContext) (receipt RsiReceipt) {
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
		service.rsiRecord(context, failure)
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

	// A failed attempt keeps its files uncommitted so the Agent can keep fixing
	// them. Those paths stay editable; unrelated user edits still block.
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
	// An empty change list is valid when there is pending work to re-check or a
	// custom check to run; the default validation always runs anyway.
	if len(input.Changes) == 0 && len(checks) == 0 && len(owned) == 0 {
		Raise("invalid_input", "Provide at least one file change or one check to run")
	}
	// Checks run against the whole working tree, so a green run only proves the commit when the
	// commit contains everything that was dirty while they ran. Anything else is refused up front
	// instead of being silently left out of the commit that gets reported as verified.
	// A path this change writes is not "outside" it, even when the Agent's own
	// tools already put it on disk: the change overwrites it before the checks run
	// and the commit holds exactly the content that was checked. Anything else
	// that is dirty still blocks - the checks would verify work the commit cannot
	// contain.
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

	createdBranch := false
	if originalBranch == nil || branch != *originalBranch {
		switched := Git(*root, []string{"switch", "-c", branch}, nil, nil)
		if switched.Code != 0 {
			Raise("rsi_git", rsiFirstText(switched.Stderr, "Failed to create "+branch))
		}
		createdBranch = true
	}

	// Paths this change does not own are somebody else's uncommitted work: they
	// must not decide whether it lands, and they must never end up inside it. See
	// runtime_rsi_isolated.go for the tree the change is built in instead.
	claimedPaths := append(append([]string{}, uniquePaths...), ownedOrder...)
	work := *root
	isolated := false
	isolatedCleanup := func() {}
	if len(blocked) > 0 {
		snapshot, ok, cleanup := rsiIsolatedWorktree(*root, claimedPaths)
		if !ok {
			// Fail closed: without an isolated tree the checks would measure work the
			// commit cannot contain, which is the reason this guard exists.
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
		// Restoring the files leaves the index alone, and an index entry outlives the attempt that made it:
		// `git add -A -- good ignored` stages the good path and then fails on the ignored one, so a
		// rolled-back call used to leave `A good` behind - which the next attempt reads as somebody else's
		// uncommitted work and refuses to run. The harness never starts with unowned dirty paths, so
		// resetting these can only undo our own staging.
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
		// Restore only what this attempt wrote; keep files a prior failed attempt
		// still owns so its fix is not lost either.
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
		service.rsiRecord(context, failure)
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
			// A whole-file write carries no evidence of what it removed. The one
			// mistake it invites - pasting a placeholder instead of the file - reads
			// as a successful change to every check that does not open the content,
			// so a write that guts a large file is refused and the caller is pointed
			// at the form that names what it deletes.
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

	// `app:build` only matters when the served page or the desktop package can move; a runtime-only
	// change is fully covered by `node --run check`, and rebuilding would overwrite the bundle the
	// running window serves with this checkout's own build.
	var changedPaths []string
	if service.runningCommit != nil {
		changedPaths = rsiChangedSince(work, *service.runningCommit)
	}
	relevant := append([]string{}, uniquePaths...)
	relevant = append(relevant, ownedOrder...)
	relevant = append(relevant, changedPaths...)
	needsBuild := changedPaths == nil || rsiBuildRelevant(relevant)
	raw := service.validate(RsiValidateInput{Root: work, Checks: checks, Activate: activate, NeedsBuild: needsBuild})
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
		// A rehearsal leaves nothing behind: the files go back to the snapshots the
		// moment the verdict is in, and a branch created just for it goes away.
		// Nothing is staged yet - staging runs after this point - so the index is
		// already untouched.
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
		service.rsiRecord(context, rehearsal)
		return rehearsal
	}
	if failed {
		// Keep the working tree so the Agent can iterate; a flaky or genuinely
		// failing check must not discard the change.
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
			// The gate measured the isolated tree, so that is the tree the next attempt
			// has to iterate on. Only this change's own paths move; the foreign files in
			// the shared checkout stay exactly as they are.
			rsiCopyPaths(work, *root, pendingFiles)
		}
		_ = service.rsiWriteWorking(branch, pendingFiles)
		failure := RsiReceipt{
			Id: id, Status: "checks_failed", Title: title, Root: root, Branch: &branch, Commit: nil,
			Files: uniquePaths, Validation: validation, RestartRequired: false,
			PendingFiles: pendingFiles, OutputPath: &outputPath,
		}
		failure.Report = rsiChecksFailedReport(input, failure)
		service.rsiRecord(context, failure)
		return failure
	}

	// The checks just ran against the working tree, so they verified every path that is dirty
	// here: a run that leaves the checkout dirty must not be committed as if it were green.
	// Paths this attempt wrote are expected to be dirty; anything else was verified by the checks
	// but would stay out of the commit, so the green run must not become a commit.
	unverified := []string{}
	for _, path := range rsiDirtyPaths(work) {
		// The isolated tree links the real checkout's dependencies, and a checkout
		// whose ignore rules do not cover them would read that link as work nobody
		// declared. It is the one entry in that tree HEAD does not own.
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

	// Commit every path this attempt or a prior attempt owns, so a checks-only
	// re-run still lands the pending files. Stage only paths that exist now or
	// were tracked before, so a delete of a never-tracked file cannot fail.
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
	_ = os.Remove(service.rsiWorkingPath())

	// Activation exists to put a new commit into the running daemon. When this call committed
	// nothing and the daemon already runs HEAD (a checks-only re-run, for example), a reload would
	// only interrupt the user, so it is skipped and reported as such.
	live := commit != nil && service.runningCommit != nil && *commit == *service.runningCommit
	restartRequired := activate && !live
	if restartRequired {
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
		Files: stagePaths, Validation: validation, RestartRequired: restartRequired,
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
	service.rsiRecord(context, applied)
	return applied
}

// rsiChangeContent is the new text of one change: given inline, or read from a
// file the Agent already wrote in the checkout.
//
// The second form exists because the most expensive call this tool served was a
// file pasted back in: the Agent writes a keeper test with its own tools, runs
// it, and then had to repeat every line inside `changes[]`. Naming the file
// commits exactly the bytes that were verified.
func rsiChangeContent(root string, change RsiFileChange, index int) string {
	if change.FromPath == nil {
		if change.Content == nil {
			Raise("invalid_input", "changes["+itoa(index)+"] has no content: give content or fromPath")
		}
		return *change.Content
	}
	source, ok := rsiInside(root, *change.FromPath)
	if !ok {
		Raise("invalid_input", "changes["+itoa(index)+"].fromPath must stay inside the Graph source root")
	}
	raw, err := os.ReadFile(filepath.Join(root, source))
	if err != nil {
		if os.IsNotExist(err) {
			Raise("not_found", "changes["+itoa(index)+"].fromPath "+source+
				" does not exist in the checkout: write the file first, then name it here instead of pasting its text")
		}
		Raise("rsi_edit_conflict", "changes["+itoa(index)+"].fromPath "+source+" could not be read: "+err.Error())
	}
	return string(raw)
}

// rsiEditMismatch names one anchor that does not match exactly once.
func rsiEditMismatch(index, total, matches int, oldText string) string {
	head := strings.TrimSpace(strings.Split(oldText, "\n")[0])
	runes := []rune(head)
	if len(runes) > 90 {
		head = string(runes[:90])
	}
	return "found " + itoa(matches) + " (edit " + itoa(index+1) + " of " + itoa(total) + ", first line: " + head + ")"
}

// rsiWriteShrinkRefusal refuses a write that would replace a large file with a
// stub.
//
// The rule is deliberately blunt: a file of rsiWriteShrinkLines lines or more
// may not be written down to less than a tenth of itself in one write. Anything
// smaller is ordinary editing; anything larger is either a rewrite that deserves
// to be spelled out as edits, or the accident this guard exists for.
const rsiWriteShrinkLines = 200

func rsiWriteShrinkRefusal(path, before, after string) string {
	oldLines := strings.Count(before, "\n") + 1
	if oldLines < rsiWriteShrinkLines {
		return ""
	}
	newLines := strings.Count(after, "\n") + 1
	if newLines*10 >= oldLines {
		return ""
	}
	return fmt.Sprintf(
		"RSI write to %s would replace %d lines with %d: a whole-file write carries no evidence of what it removed. "+
			"Use replace with edits that name what goes, or split the deletion into several such edits.", path, oldLines, newLines)
}

