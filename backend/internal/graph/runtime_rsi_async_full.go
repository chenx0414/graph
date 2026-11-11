package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var rsiEscapeCode = regexp.MustCompile("\\x1b\\[[0-9;]*[A-Za-z]")

func rsiAsyncFullCommand() RsiCommand {
	return RsiCommand{Command: "go", Args: []string{"-C", "backend", "run", "./cmd/graphcheck", "all"}, Nice: 10}
}

type rsiAsyncFullJob struct {
	ActivationID  string
	Commit        string
	Conversations []string
	Coalesced     int
}

type rsiAsyncFullState struct {
	mu      sync.Mutex
	running bool
	pending *rsiAsyncFullJob
	report  string
	exec    func(*TaskStore, rsiAsyncFullJob)
}

func (service *RsiService) rsiStartAsyncFull(store *TaskStore, activationID, commit string, conversations []string) {
	if service.Root == nil || activationID == "" || len(conversations) == 0 {
		return
	}
	job := rsiAsyncFullJob{ActivationID: activationID, Commit: commit, Conversations: append([]string{}, conversations...), Coalesced: 1}
	state := &service.asyncFull
	state.mu.Lock()
	if state.running {
		state.pending = rsiAsyncFullCoalesce(state.pending, job)
		state.mu.Unlock()
		return
	}
	state.running = true
	state.mu.Unlock()
	go service.rsiDrainAsyncFull(store, job)
}

func rsiAsyncFullCoalesce(pending *rsiAsyncFullJob, job rsiAsyncFullJob) *rsiAsyncFullJob {
	if pending == nil {
		return &job
	}
	merged := rsiAsyncFullJob{ActivationID: job.ActivationID, Commit: job.Commit, Coalesced: pending.Coalesced + 1}
	seen := map[string]bool{}
	for _, conversationID := range append(append([]string{}, pending.Conversations...), job.Conversations...) {
		if seen[conversationID] {
			continue
		}
		seen[conversationID] = true
		merged.Conversations = append(merged.Conversations, conversationID)
	}
	return &merged
}

func (service *RsiService) rsiDrainAsyncFull(store *TaskStore, job rsiAsyncFullJob) {
	state := &service.asyncFull
	for {
		service.rsiExecuteAsyncFull(store, job)
		state.mu.Lock()
		pending := state.pending
		state.pending = nil
		if pending == nil {
			state.running = false
			state.mu.Unlock()
			return
		}
		state.mu.Unlock()
		job = *pending
	}
}

func (service *RsiService) rsiExecuteAsyncFull(store *TaskStore, job rsiAsyncFullJob) {
	if service.asyncFull.exec != nil {
		service.asyncFull.exec(store, job)
		return
	}
	service.rsiRunAsyncFull(store, job)
}

func (service *RsiService) rsiRunAsyncFull(store *TaskStore, job rsiAsyncFullJob) {
	root := *service.Root
	stateDir := service.stateDir
	runRoot, cleanup := rsiSnapshotRoot(root, job.Commit)
	defer cleanup()
	result := rsiRunCommand(runRoot, rsiAsyncFullCommand(), RSI_ASYNC_FULL_TIMEOUT_MS)
	logPath := filepath.Join(stateDir, "rsi", "reports", "async-full-"+job.ActivationID+".log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err == nil {
		header := "ran in " + runRoot + "\n"
		_ = os.WriteFile(logPath, []byte(header+result.Output), 0o600)
	}
	if result.Status == "passed" {
		service.rsiAsyncFullNotePass()
		return
	}
	known, _ := LoadEnvKnownReds(filepath.Join(runRoot, "backend", "internal", "graph", "testdata", "env-known-reds.json"))
	classified := ClassifyAsyncFull(result.Output, known)
	environment := classified.Environment
	verdict := "回归"
	if classified.Reason != "" {
		verdict = "环境故障（" + classified.Reason + "），先别当回归追"
	} else if environment {
		verdict = "环境故障（失败项都命中 tests/env-known-reds.json 的已知环境问题），先别当回归追"
	}
	if len(classified.Unmatched) > 0 {
		verdict += "；未匹配: " + strings.Join(classified.Unmatched, " / ")
	}
	if len(classified.Flaky) > 0 {
		verdict += "；重跑通过（不计为回归，但值得复核）: " + strings.Join(classified.Flaky, " / ")
	}
	if job.Coalesced > 1 {
		verdict += "；合并了 " + itoa(job.Coalesced) + " 次确认请求，只跑一次全量"
	}
	causes := []string{}
	for _, failure := range AsyncFullFailures(result.Output) {
		causes = append(causes, failure.File)
	}
	causes = append(causes, classified.Unmatched...)
	causes = append(causes, classified.Flaky...)
	if !service.rsiAsyncFullShouldReport(verdict, causes) {
		return
	}
	summary := rsiAsyncFullSummary(result.Output)
	for _, conversationID := range job.Conversations {
		text := rsiAsyncFullNotice(job.Commit, verdict, summary, logPath)
		AppendMessage(store, MessageInput{
			ConversationID: conversationID, Role: MessageRoleUser, Kind: "chat", Text: text, State: MessageStatePending,
			Data: map[string]any{
				"source":      map[string]any{"kind": "rsi_async_full", "activationId": job.ActivationID, "commit": job.Commit},
				"environment": environment,
			},
		})
		anchor := graphDBString(kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationID), "anchor_task_id")
		WakeMaster(store, WakeIntent{
			TaskID: anchor, Kind: "rsi_async_full", DedupeKey: job.ActivationID + ":" + conversationID,
			Data: map[string]any{"activationId": job.ActivationID, "commit": job.Commit, "environment": environment}, HasData: true,
		})
	}
}

func (service *RsiService) rsiAsyncFullShouldReport(verdict string, causes []string) bool {
	fingerprint := rsiAsyncFullFingerprint(verdict, causes)
	state := &service.asyncFull
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.report == fingerprint {
		return false
	}
	state.report = fingerprint
	return true
}

func (service *RsiService) rsiAsyncFullNotePass() {
	state := &service.asyncFull
	state.mu.Lock()
	state.report = ""
	state.mu.Unlock()
}

func rsiAsyncFullFingerprint(verdict string, causes []string) string {
	sorted := append([]string{}, causes...)
	sort.Strings(sorted)
	return verdict + "\x00" + strings.Join(sorted, "\x00")
}

func rsiAsyncFullNotice(commit, verdict, summary, logPath string) string {
	lines := []string{"[后台全量确认失败]", "提交: " + commit, "判定: " + verdict}
	for _, line := range strings.Split(rsiEscapeCode.ReplaceAllString(summary, ""), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lines = append(lines, trimmed)
		if len(lines) >= 7 {
			break
		}
	}
	lines = append(lines, "完整日志: "+logPath)
	return strings.Join(lines, "\n")
}

func rsiAsyncFullSummary(output string) string {
	output = rsiEscapeCode.ReplaceAllString(output, "")
	all := []string{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			all = append(all, trimmed)
		}
	}
	kept := []string{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "check:tests:") || strings.Contains(trimmed, "FAIL ") ||
			strings.Contains(trimmed, "Test Files") || strings.Contains(trimmed, "shrank") ||
			strings.Contains(trimmed, "failed outside the quarantine") {
			kept = append(kept, trimmed)
		}
	}
	if len(kept) > 20 {
		kept = kept[len(kept)-20:]
	}
	if len(kept) == 0 {
		if len(all) == 0 {
			return "摘要: 命令没有任何输出，请读完整日志。"
		}
		head, tail := all, []string{}
		if len(head) > 3 {
			head = head[:3]
		}
		if len(all) > 3 {
			tail = all[len(all)-1:]
		}
		return "摘要:\n" + strings.Join(append(head, tail...), "\n")
	}
	return "摘要:\n" + strings.Join(kept, "\n")
}

const rsiSnapshotMaxAge = 2 * time.Hour

var rsiSnapshotLockHolder = regexp.MustCompile(`\(pid ([0-9]+)\)`)

func rsiSnapshotHolderGone(reason string) bool {
	match := rsiSnapshotLockHolder.FindStringSubmatch(reason)
	if match == nil {
		return false
	}
	pid, err := strconv.Atoi(match[1])
	if err != nil || pid <= 0 {
		return false
	}
	return !rsiProcessAlive(pid)
}

func rsiPruneStaleSnapshots(root string) int {
	output, err := exec.Command("git", "-C", root, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return 0
	}
	removed := 0
	for _, block := range strings.Split(string(output), "\n\n") {
		path, lockReason := "", ""
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				path = strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
			case strings.HasPrefix(line, "locked"):
				lockReason = strings.TrimSpace(strings.TrimPrefix(line, "locked"))
			}
		}
		if path == "" || !strings.HasPrefix(filepath.Base(path), "graph-async-full-") {
			continue
		}
		if lockReason != "" {
			if !rsiSnapshotHolderGone(lockReason) {
				continue
			}
			_ = exec.Command("git", "-C", root, "worktree", "unlock", path).Run()
		} else if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) < rsiSnapshotMaxAge {
			continue
		}
		if err := exec.Command("git", "-C", root, "worktree", "remove", "--force", path).Run(); err != nil {
			_ = os.RemoveAll(path)
		}
		removed++
	}
	if removed > 0 {
		_ = exec.Command("git", "-C", root, "worktree", "prune").Run()
	}
	return removed
}

const rsiScratchMaxAge = 6 * time.Hour

func rsiPruneStaleScratchDirs(now time.Time) int {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "graph-") {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < rsiScratchMaxAge {
			continue
		}
		if os.RemoveAll(filepath.Join(os.TempDir(), entry.Name())) == nil {
			removed++
		}
	}
	return removed
}

func rsiSnapshotRoot(root, commit string) (string, func()) {
	noop := func() {}
	if strings.TrimSpace(commit) == "" {
		return root, noop
	}
	dir, err := os.MkdirTemp("", "graph-async-full-")
	if err != nil {
		return root, noop
	}
	if _, err := exec.Command("git", "-C", root, "worktree", "add", "--detach", dir, commit).CombinedOutput(); err != nil {
		_ = os.RemoveAll(dir)
		return root, noop
	}
	if err := os.Symlink(filepath.Join(root, "node_modules"), filepath.Join(dir, "node_modules")); err != nil {
		_ = exec.Command("git", "-C", root, "worktree", "remove", "--force", dir).Run()
		_ = os.RemoveAll(dir)
		return root, noop
	}
	return dir, func() {
		_ = exec.Command("git", "-C", root, "worktree", "remove", "--force", dir).Run()
		_ = os.RemoveAll(dir)
	}
}
