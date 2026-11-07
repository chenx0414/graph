package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var rsiEscapeCode = regexp.MustCompile("\\x1b\\[[0-9;]*[A-Za-z]")

func rsiAsyncFullCommand() RsiCommand {
	return RsiCommand{Command: "node", Args: []string{"--run", "check:full"}, Nice: 10}
}

func (service *RsiService) rsiStartAsyncFull(store *TaskStore, activationID, commit string, conversations []string) {
	if service.Root == nil || activationID == "" || len(conversations) == 0 {
		return
	}
	key := activationID + "|" + commit
	if _, running := service.asyncFull.LoadOrStore(key, true); running {
		return
	}
	root := *service.Root
	stateDir := service.stateDir
	go func() {
		defer service.asyncFull.Delete(key)
		runRoot, cleanup := rsiSnapshotRoot(root, commit)
		defer cleanup()
		result := rsiRunCommand(runRoot, rsiAsyncFullCommand(), RSI_ASYNC_FULL_TIMEOUT_MS)
		logPath := filepath.Join(stateDir, "rsi", "reports", "async-full-"+activationID+".log")
		if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err == nil {
			header := "ran in " + runRoot + "\n"
			_ = os.WriteFile(logPath, []byte(header+result.Output), 0o600)
		}
		if result.Status == "passed" {
			return
		}
		known, _ := LoadEnvKnownReds(filepath.Join(runRoot, "tests", "env-known-reds.json"))
		classified := ClassifyAsyncFull(result.Output, known)
		environment := classified.Environment
		verdict := "回归"
		if environment {
			verdict = "环境故障（失败项都命中 tests/env-known-reds.json 的已知环境问题），先别当回归追"
		}
		if len(classified.Unmatched) > 0 {
			verdict += "；未匹配: " + strings.Join(classified.Unmatched, " / ")
		}
		summary := rsiAsyncFullSummary(result.Output)
		for _, conversationID := range conversations {
			text := rsiAsyncFullNotice(commit, verdict, summary, logPath)
			AppendMessage(store, MessageInput{
				ConversationID: conversationID, Role: MessageRoleUser, Kind: "chat", Text: text, State: MessageStatePending,
				Data: map[string]any{
					"source":      map[string]any{"kind": "rsi_async_full", "activationId": activationID, "commit": commit},
					"environment": environment,
				},
			})
			anchor := graphDBString(kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationID), "anchor_task_id")
			WakeMaster(store, WakeIntent{
				TaskID: anchor, Kind: "rsi_async_full", DedupeKey: activationID + ":" + conversationID,
				Data: map[string]any{"activationId": activationID, "commit": commit, "environment": environment}, HasData: true,
			})
		}
	}()
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

func rsiPruneStaleSnapshots(root string) int {
	output, err := exec.Command("git", "-C", root, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return 0
	}
	removed := 0
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.HasPrefix(line, "worktree ") {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
		if !strings.HasPrefix(filepath.Base(path), "graph-async-full-") {
			continue
		}
		if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) < rsiSnapshotMaxAge {
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
