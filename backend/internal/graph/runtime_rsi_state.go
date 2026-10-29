package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"bytes"
)

// rsiDiffFor is the diff of one commit, bounded to the report size.
func rsiDiffFor(root, commit string) *string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	process := exec.CommandContext(ctx, "git", "show", "--format=", "--no-ext-diff", "--unified=3", commit)
	process.Dir = root
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	process.Stdout = stdout
	process.Stderr = stderr
	if err := process.Run(); err != nil {
		return nil
	}
	diff := strings.TrimSpace(stdout.String())
	runes := []rune(diff)
	if len(runes) > RSI_MAX_REPORT_DIFF {
		diff = string(runes[:RSI_MAX_REPORT_DIFF]) + "\n... diff truncated ..."
	}
	return &diff
}

// rsiRestartPath is where the pending reload request lives.
func (service *RsiService) rsiRestartPath() string {
	return filepath.Join(service.stateDir, "rsi", "restart.json")
}

// rsiWorkingPath is where the files of a failed attempt live.
func (service *RsiService) rsiWorkingPath() string {
	return filepath.Join(service.stateDir, "rsi", "working.json")
}

// rsiDirtyPaths lists the uncommitted paths in the checkout. Checks run against the working tree, so a
// path here that the commit would not contain makes a green run prove the wrong thing.
func rsiDirtyPaths(root string) []string {
	seen := map[string]bool{}
	for _, args := range [][]string{{"diff", "--name-only", "HEAD"}, {"ls-files", "--others", "--exclude-standard"}} {
		result := Git(root, args, nil, nil)
		for _, line := range strings.Split(result.Stdout, "\n") {
			path := strings.TrimSpace(line)
			if path != "" {
				seen[path] = true
			}
		}
	}
	paths := []string{}
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// HasPendingRestart keeps queued work intact while the desktop drains existing operations.
func (service *RsiService) HasPendingRestart() bool {
	_, err := os.Stat(service.rsiRestartPath())
	return err == nil
}

// rsiWriteReportFile keeps the full check output for one attempt out of the receipt the conversation stores.
func (service *RsiService) rsiWriteReportFile(id string, validation []RsiValidationResult) string {
	directory := filepath.Join(service.stateDir, "rsi", "reports")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		panic(err)
	}
	path := filepath.Join(directory, id+".log")
	sections := []string{}
	for _, item := range validation {
		sections = append(sections, "$ "+item.Command+"\n["+item.Status+"]\n"+item.Output+"\n")
	}
	if err := os.WriteFile(path, []byte(strings.Join(sections, "\n")), 0o600); err != nil {
		panic(err)
	}
	return path
}

// rsiReadRestart reads the pending reload request.
func (service *RsiService) rsiReadRestart() *RsiPendingRestart {
	raw, err := os.ReadFile(service.rsiRestartPath())
	if err != nil {
		return nil
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	if _, ok := fields["id"].(string); !ok {
		return nil
	}
	if _, ok := fields["root"].(string); !ok {
		return nil
	}
	var restart RsiPendingRestart
	if err := json.Unmarshal(raw, &restart); err != nil {
		return nil
	}
	return &restart
}

// rsiReadWorking reads the files a previous failed attempt left uncommitted. They stay editable so the
// Main Agent can keep fixing the same change instead of losing it to a flaky check, while unrelated
// user edits still block the change set.
func (service *RsiService) rsiReadWorking() *RsiWorkingFiles {
	raw, err := os.ReadFile(service.rsiWorkingPath())
	if err != nil {
		return nil
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	branch, ok := fields["branch"].(string)
	if !ok {
		return nil
	}
	rawPaths, ok := fields["paths"].([]any)
	if !ok {
		return nil
	}
	paths := []string{}
	for _, item := range rawPaths {
		if path, isText := item.(string); isText {
			paths = append(paths, path)
		}
	}
	return &RsiWorkingFiles{Branch: branch, Paths: paths}
}

// RsiWorkingFiles are the files a failed attempt left uncommitted.
type RsiWorkingFiles struct {
	Branch string
	Paths  []string
}

// rsiWriteWorking records the files a failed attempt left behind.
func (service *RsiService) rsiWriteWorking(branch string, paths []string) error {
	unique := map[string]bool{}
	for _, path := range paths {
		unique[path] = true
	}
	sorted := []string{}
	for path := range unique {
		sorted = append(sorted, path)
	}
	sort.Strings(sorted)
	lines := []string{"{", "  \"branch\": " + rsiJSONString(branch) + ","}
	if len(sorted) == 0 {
		lines = append(lines, "  \"paths\": []")
	} else {
		lines = append(lines, "  \"paths\": [")
		for index, path := range sorted {
			separator := ","
			if index == len(sorted)-1 {
				separator = ""
			}
			lines = append(lines, "    "+rsiJSONString(path)+separator)
		}
		lines = append(lines, "  ]")
	}
	lines = append(lines, "}")
	return rsiWriteAtomic(service.rsiWorkingPath(), strings.Join(lines, "\n")+"\n")
}

// rsiWriteRestart records the reload request the host has to confirm.
func (service *RsiService) rsiWriteRestart(id, root, branch string, commit *string, requestedAt int64, generation int, force bool) error {
	lines := []string{
		"{",
		"  \"id\": " + rsiJSONString(id) + ",",
		"  \"root\": " + rsiJSONString(root) + ",",
		"  \"branch\": " + rsiJSONString(branch) + ",",
		"  \"commit\": " + rsiJSONStringOrNull(commit) + ",",
		"  \"requestedAt\": " + fmt.Sprintf("%d", requestedAt) + ",",
		"  \"generation\": " + fmt.Sprintf("%d", generation),
	}
	if force {
		lines[len(lines)-1] += ","
		lines = append(lines, "  \"force\": true")
	}
	lines = append(lines, "}")
	return rsiWriteAtomic(service.rsiRestartPath(), strings.Join(lines, "\n")+"\n")
}

// Status is the whole self-improvement surface as one read.
func (service *RsiService) Status(compare bool) RsiStatus {
	status := RsiStatus{
		Operations:      []RsiOperation{},
		OperationsKnown: true,
		PendingRestart:  service.rsiReadRestart(),
		LastActivation:  service.rsiReadActivation(),
	}
	if service.Available && service.Root != nil {
		status.Available = true
		status.Root = service.Root
		status.Branch = CheckedOutBranch(*service.Root)
		status.Sync = service.rsiSyncState(*service.Root, compare)
	} else {
		reason := service.rsiUnavailableReason()
		status.Reason = &reason
	}
	operations, known := rsiReadOperations(service.stateDir)
	if known {
		status.Operations = operations
		status.ActiveOperations = len(operations)
	} else {
		status.Operations = []RsiOperation{}
		status.ActiveOperations = 0
		status.OperationsKnown = false
	}
	canRestart := false
	if status.PendingRestart != nil {
		// A forced request reloads even with operations in flight; a normal one
		// waits for the ledger to drain.
		canRestart = status.PendingRestart.Force || (status.OperationsKnown && status.ActiveOperations == 0)
	}
	status.CanRestart = canRestart
	return status
}

// rsiReadActivation reads the last confirmed reload.
func (service *RsiService) rsiReadActivation() *RsiLastActivation {
	raw, err := os.ReadFile(filepath.Join(service.stateDir, "rsi", "activated.json"))
	if err != nil {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	if value == nil {
		return nil
	}
	var activation RsiLastActivation
	if err := json.Unmarshal(raw, &activation); err != nil {
		return nil
	}
	return &activation
}

// rsiReadOperations reads the in-flight operations from the task ledger.
func rsiReadOperations(stateDir string) ([]RsiOperation, bool) {
	dbPath := filepath.Join(stateDir, "tasks.sqlite")
	if _, err := os.Stat(dbPath); err != nil {
		return []RsiOperation{}, true
	}
	operations := []RsiOperation{}
	known := true
	func() {
		defer func() {
			if recover() != nil {
				operations = []RsiOperation{}
				known = false
			}
		}()
		db, err := OpenSQLite(dbPath)
		if err != nil {
			operations = []RsiOperation{}
			known = false
			return
		}
		defer db.Close()
		rows := kernelRows(db, `
          SELECT o.id, o.task_id AS taskId, o.node_id AS nodeId, o.state,
                 t.request AS request, t.conversation_id AS conversationId,
                 CASE WHEN c.archived_at IS NULL THEN 0 ELSE 1 END AS archived
          FROM operations o
          JOIN tasks t ON t.id=o.task_id
          LEFT JOIN conversations c ON c.id=t.conversation_id
          WHERE o.state IN ('intent','dispatched')
          ORDER BY o.rowid
        `)
		for _, row := range rows {
			operations = append(operations, RsiOperation{
				Id:             graphDBString(row, "id"),
				TaskId:         graphDBString(row, "taskId"),
				NodeId:         graphDBString(row, "nodeId"),
				State:          graphDBString(row, "state"),
				Request:        graphDBString(row, "request"),
				ConversationId: graphDBStringPtr(row, "conversationId"),
				Archived:       graphDBInt(row, "archived") != 0,
			})
		}
	}()
	return operations, known
}

// rsiSyncState says which local branches are ahead of the copy they were published to, which of those
// are local work lines that are never published, and how many were never published at all.
//
// This exists because unpublished work is otherwise silent: the application line sat 61 commits
// ahead of its remote across several sessions and nothing in the harness said so, so a broken push
// channel looked exactly like a working one.
func (service *RsiService) rsiSyncState(root string, compare bool) *RsiSyncState {
	state := &RsiSyncState{Unpublished: []RsiSyncEntry{}, Expected: []RsiSyncEntry{}}
	heads := Git(root, []string{"for-each-ref", "--format=%(refname:short)", "refs/heads"}, nil, nil)
	if heads.Code != 0 {
		state.Note = "无法读取本地分支，未计算未发布的提交"
		state.deployCompared = compare
		if compare {
			state.Deploy = service.rsiDeployState(root)
		}
		return state
	}
	for _, branch := range strings.Split(heads.Stdout, "\n") {
		name := strings.TrimSpace(branch)
		if name == "" {
			continue
		}
		upstream := "origin/" + name
		if Git(root, []string{"rev-parse", "--verify", "--quiet", "refs/remotes/" + upstream}, nil, nil).Code != 0 {
			state.LocalOnly++
			continue
		}
		counts := Git(root, []string{"rev-list", "--left-right", "--count", "refs/remotes/" + upstream + "..." + name}, nil, nil)
		if counts.Code != 0 {
			continue
		}
		parts := strings.Fields(strings.TrimSpace(counts.Stdout))
		if len(parts) < 2 {
			continue
		}
		behind, behindOK := rsiParseCount(parts[0])
		ahead, aheadOK := rsiParseCount(parts[1])
		if !aheadOK || !behindOK || (ahead == 0 && behind == 0) {
			continue
		}
		entry := RsiSyncEntry{Branch: name, Upstream: upstream, Ahead: ahead, Behind: behind}
		if strings.HasPrefix(name, "rsi/") {
			state.Expected = append(state.Expected, entry)
		} else {
			state.Unpublished = append(state.Unpublished, entry)
		}
	}
	sort.Slice(state.Unpublished, func(left, right int) bool { return state.Unpublished[left].Branch < state.Unpublished[right].Branch })
	sort.Slice(state.Expected, func(left, right int) bool { return state.Expected[left].Branch < state.Expected[right].Branch })
	// Debt first when there is any, so the actionable line is never buried behind a standing one.
	parts := []string{}
	if len(state.Unpublished) > 0 {
		entries := []string{}
		for _, item := range state.Unpublished {
			entries = append(entries, item.Branch+" 领先 "+item.Upstream+" "+itoa(item.Ahead)+" 个提交")
		}
		parts = append(parts, "未发布："+strings.Join(entries, "；"))
	} else {
		parts = append(parts, "没有未发布的已发布分支")
	}
	if len(state.Expected) > 0 {
		entries := []string{}
		for _, item := range state.Expected {
			entries = append(entries, item.Branch+" 领先 "+item.Upstream+" "+itoa(item.Ahead)+" 个提交")
		}
		parts = append(parts, "本机自改进线按设计不推送："+strings.Join(entries, "；"))
	}
	if state.LocalOnly > 0 {
		parts = append(parts, "另有 "+itoa(state.LocalOnly)+" 个本地分支从未发布")
	}
	state.Note = strings.Join(parts, "；")
	state.deployCompared = compare
	if compare {
		state.Deploy = service.rsiDeployState(root)
	}
	return state
}

// rsiParseCount reads one ahead/behind count.
func rsiParseCount(value string) (int, bool) {
	number := 0
	if value == "" {
		return 0, false
	}
	for _, symbol := range value {
		if symbol < '0' || symbol > '9' {
			return 0, false
		}
		number = number*10 + int(symbol-'0')
	}
	return number, true
}

// rsiDeployState compares the checkout with the development line, when there is one to compare with.
//
// Several checkouts of the same repository can sit in one place; the one this checkout still agrees
// with most closely is the useful answer, and it is named in the note so the reader knows which.
func (service *RsiService) rsiDeployState(root string) *DeployDriftReport {
	drifts := []DeployDriftReport{}
	for _, candidate := range DevelopmentCandidates(root, nil) {
		drifts = append(drifts, DeployDrift(root, candidate))
	}
	if len(drifts) == 0 {
		return nil
	}
	sort.SliceStable(drifts, func(left, right int) bool {
		return len(drifts[left].Files)+len(drifts[left].Missing)+len(drifts[left].Extra) <
			len(drifts[right].Files)+len(drifts[right].Missing)+len(drifts[right].Extra)
	})
	drift := drifts[0]
	return &drift
}

// rsiUnavailableReason says why the service cannot work.
func (service *RsiService) rsiUnavailableReason() string {
	if service.Root == nil {
		return "No Graph source checkout was found. Set GRAPH_RSI_ROOT to the checkout the app runs from."
	}
	if _, err := os.Stat(filepath.Join(*service.Root, "package.json")); err != nil {
		return *service.Root + " has no package.json, so it is not a Graph source checkout."
	}
	return *service.Root + " is not a Git checkout root; run Graph from a source checkout to enable self-improvement."
}

// AckRestart clears a pending restart once the host has actually reloaded the daemon for
// that exact request. A stale id never clears a newer request, so a crashed
// restart keeps its intent instead of silently dropping it.
func (service *RsiService) AckRestart(id string, store *TaskStore) RsiAckRestart {
	current := service.rsiReadRestart()
	if current == nil || current.Id != id {
		return RsiAckRestart{Cleared: false, PendingRestart: current}
	}
	generation := int(rsiRuntimeGeneration(store))
	// A matching HTTP response alone is not proof: the daemon must have
	// restarted onto the requested commit, rather than still running old code.
	if current.Root != rsiStringValue(service.Root) || !rsiSameOptional(current.Commit, service.runningCommit) ||
		(current.Generation != nil && int64(generation) <= *current.Generation) {
		return RsiAckRestart{Cleared: false, PendingRestart: current}
	}
	confirmed := RsiLastActivation{Id: id, Commit: current.Commit, ConfirmedAt: NowMillis(), Generation: generation}
	confirmedGeneration := int64(confirmed.Generation)
	touched := []string{}
	for _, row := range kernelRows(store.Db, "SELECT DISTINCT conversation_id FROM messages WHERE kind='rsi' AND json_extract(data,'$.id')=?", id) {
		if value := graphDBString(row, "conversation_id"); value != "" {
			touched = append(touched, value)
		}
	}
	store.Transaction(func() any {
		messages := kernelRows(store.Db, "SELECT id,conversation_id,text,data FROM messages WHERE kind='rsi' AND json_extract(data,'$.id')=?", id)
		for _, message := range messages {
			conversationID := graphDBString(message, "conversation_id")
			messageID := graphDBString(message, "id")
			receipt := RsiReceipt{}
			if err := json.Unmarshal([]byte(graphDBString(message, "data")), &receipt); err != nil {
				continue
			}
			if receipt.Activation != nil && receipt.Activation.State == "active" {
				continue
			}
			receipt.Activation = &RsiReceiptActivation{State: "active", ConfirmedAt: &confirmed.ConfirmedAt, Generation: &confirmedGeneration}
			receipt.Report = graphDBString(message, "text") + "\n\n- 重载已确认：提交 " + rsiStringValue(current.Commit) + " 已生效。"
			AppendMessage(store, MessageInput{
				ConversationID: conversationID, MessageID: &messageID, Role: "system", Kind: "rsi",
				Text: receipt.Report, Data: receipt, State: "done",
			})
			taskID := graphDBString(kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationID), "anchor_task_id")
			store.Event(taskID, "rsi.activated", confirmed)
		}
		ConfirmRsiContinuation(store, id)
		return nil
	})
	encoded, err := json.Marshal(confirmed)
	if err != nil {
		panic(err)
	}
	if err := rsiWriteAtomic(filepath.Join(service.stateDir, "rsi", "activated.json"), string(encoded)); err != nil {
		panic(err)
	}
	_ = os.Remove(service.rsiRestartPath())
	// The change is live; now prove the rest of the suite, off this path.
	service.rsiStartAsyncFull(store, id, rsiStringValue(current.Commit), touched)
	return RsiAckRestart{Cleared: true, PendingRestart: nil}
}

// rsiRuntimeGeneration reads the runtime generation the daemon counts reloads with.
func rsiRuntimeGeneration(store *TaskStore) int64 {
	row := kernelRow(store.Db, "SELECT generation FROM runtime")
	if row == nil {
		return 0
	}
	return graphDBInt(row, "generation")
}

// rsiStringValue is the value of an optional string, or the empty string.
func rsiStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// rsiSameOptional compares two optional strings the way TypeScript compares `string | null`.
func rsiSameOptional(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
