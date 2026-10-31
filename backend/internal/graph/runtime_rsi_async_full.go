package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// rsiStartAsyncFull runs the slow confirmation after a reload.
//
// The gate that proves a change before it goes live is the fast one, so the
// whole suite still has to be proven afterwards. It runs here, in the
// background, exactly when the reload is confirmed - not when somebody
// remembers, because that is the same as never.
//
// A failure comes back as a message the supervisor is woken for: a check nobody
// reads is a check that never ran. An environment fault says so, so a dropped
// network does not open a hunt for a regression that does not exist.
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
		// The confirmation runs against the commit, not against whatever the
		// checkout happens to contain right now. The supervisor keeps working in
		// the same clone - switching branches, merging, pushing - and a suite that
		// reads a tree changing under it reports a regression nobody introduced
		// (measured: a moved file looked like a missing module).
		runRoot, cleanup := rsiSnapshotRoot(root, commit)
		defer cleanup()
		result := rsiRunCommand(runRoot, RsiCommand{Command: "node", Args: []string{"--run", "check:full"}}, RSI_ASYNC_FULL_TIMEOUT_MS)
		logPath := filepath.Join(stateDir, "rsi", "reports", "async-full-"+activationID+".log")
		if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err == nil {
			header := "ran in " + runRoot + "\n"
			_ = os.WriteFile(logPath, []byte(header+result.Output), 0o600)
		}
		if result.Status == "passed" {
			return
		}
		environment := IsEnvironmentFailure(result.Output)
		verdict := "回归"
		if environment {
			verdict = "环境故障（重试后仍失败），先别当回归追"
		}
		summary := rsiAsyncFullSummary(result.Output)
		for _, conversationID := range conversations {
			text := "[后台全量确认失败]\n提交: " + commit + "\n判定: " + verdict + "\n" + summary + "\n完整日志: " + logPath
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

// rsiAsyncFullSummary keeps the failure message readable: the lines that name
// what broke, bounded, instead of a whole suite log inside a chat message.
func rsiAsyncFullSummary(output string) string {
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
		return "摘要: 日志里没有可归纳的行，请读完整日志。"
	}
	return "摘要:\n" + strings.Join(kept, "\n")
}

// rsiSnapshotRoot checks out one commit into a throwaway worktree and points it
// at the real dependencies, so the slow confirmation reads an immutable tree.
//
// A worktree without node_modules cannot run the suite, so the module directory
// is linked rather than copied; anything that stops the snapshot from being made
// falls back to the working checkout, and the log says which one ran.
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
