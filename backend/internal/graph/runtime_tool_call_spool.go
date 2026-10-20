package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Worker lanes run in a child process that holds no store, so their tool calls cannot be
// written by the daemon's own seam. They are spooled to a file inside the state directory
// the worker was already given, and folded into `tool_calls` on the next read.
//
// That directory is the lane's own instance directory: a lane receives its session directory as
// `stateDir`, so its spool lands at `<stateDir>/instances/<instanceId>/tool-calls/`. The daemon's
// own root is read as well, because a lane handed the root (a host-run check, a fixture) writes
// there. Both places are the same convention seen from two ends; reading only the root reported
// zero calls for every lane while the samples sat on disk.
//
// A file, not a new protocol: the worker already writes only inside that directory, and an
// append cannot block the turn it observes. Losing a sample is acceptable; breaking a tool
// call is not, so every write here swallows its own failure.

// TOOL_CALL_SPOOL_DIR is the directory a worker instance spools its calls into.
const TOOL_CALL_SPOOL_DIR = "tool-calls"

// INSTANCES_DIR is the directory one instance directory lives in.
const INSTANCES_DIR = "instances"

// TOOL_CALL_SPOOL_RETAIN_DAYS is how long a fully consumed spool is kept on disk.
const TOOL_CALL_SPOOL_RETAIN_DAYS = 90

// ToolCallSpoolCall is one tool call the worker reports.
type ToolCallSpoolCall struct {
	Tool    string
	Ms      float64
	IsError bool
	Target  *string
}

// toolCallSpoolLine is one spooled record, in the order the worker writes it.
type toolCallSpoolLine struct {
	InstanceId string  `json:"instanceId"`
	Tool       string  `json:"tool"`
	Ms         int64   `json:"ms"`
	IsError    bool    `json:"isError"`
	At         int64   `json:"at"`
	Target     *string `json:"target,omitempty"`
}

// ToolCallSpoolPath is where one worker instance spools its calls.
func ToolCallSpoolPath(stateDir string, instanceId string) string {
	// An instance id is a uuid today; a file name is not the place to rely on that.
	return filepath.Join(stateDir, TOOL_CALL_SPOOL_DIR, toolCallSpoolFileName(instanceId)+".jsonl")
}

// toolCallSpoolFileName replaces every character a file name cannot carry.
func toolCallSpoolFileName(instanceId string) string {
	var b strings.Builder
	for _, character := range instanceId {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '.', character == '_', character == '-':
			b.WriteRune(character)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// SpoolToolCall is called from the worker's tool-call seam. It never fails a turn.
func SpoolToolCall(stateDir string, instanceId string, call ToolCallSpoolCall) {
	defer func() {
		// An unwritable spool is a missing sample, never a failed tool call.
		_ = recover()
	}()
	directory := filepath.Join(stateDir, TOOL_CALL_SPOOL_DIR)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return
	}
	ms := int64(0)
	if call.Ms > 0 {
		ms = int64(call.Ms + 0.5)
	}
	line := toolCallSpoolLine{InstanceId: instanceId, Tool: call.Tool, Ms: ms, IsError: call.IsError, At: NowMillis()}
	if call.Target != nil && *call.Target != "" {
		target := *call.Target
		line.Target = &target
	}
	encoded, err := json.Marshal(line)
	if err != nil {
		return
	}
	file, err := os.OpenFile(ToolCallSpoolPath(stateDir, instanceId), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(encoded, '\n'))
}

// parseSpooledLine reads one spooled record.
func parseSpooledLine(line string) *toolCallSpoolLine {
	var value map[string]any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return nil
	}
	instanceId, ok := value["instanceId"].(string)
	if !ok {
		return nil
	}
	tool, ok := value["tool"].(string)
	if !ok {
		return nil
	}
	parsed := &toolCallSpoolLine{InstanceId: instanceId, Tool: tool}
	if ms, ok := value["ms"].(float64); ok {
		parsed.Ms = int64(ms)
	}
	parsed.IsError = value["isError"] == true
	if at, ok := value["at"].(float64); ok {
		parsed.At = int64(at)
	} else {
		parsed.At = NowMillis()
	}
	if target, ok := value["target"].(string); ok {
		parsed.Target = &target
	}
	return parsed
}

// toolCallSpoolPass is one in-flight ingest for a state directory.
type toolCallSpoolPass struct {
	done   chan struct{}
	result int
}

// toolCallSpoolIngests keeps one pass per state directory at a time; a caller arriving during a
// pass joins it.
var toolCallSpoolIngests = struct {
	sync.Mutex
	passes map[string]*toolCallSpoolPass
}{passes: map[string]*toolCallSpoolPass{}}

// IngestToolCallSpools folds spooled worker calls into the store, continuing from the byte
// offset recorded per file. That offset is what makes an ingest idempotent, and it also means a
// partially written last line is simply read again next time. A file that shrank was rewritten by
// someone else, so the read starts over rather than trusting a stale offset.
func IngestToolCallSpools(store *TaskStore, stateDir string, keepDays ...int) int {
	days := TOOL_CALL_SPOOL_RETAIN_DAYS
	if len(keepDays) > 0 {
		days = keepDays[0]
	}
	toolCallSpoolIngests.Lock()
	if running, ok := toolCallSpoolIngests.passes[stateDir]; ok {
		toolCallSpoolIngests.Unlock()
		<-running.done
		return running.result
	}
	pass := &toolCallSpoolPass{done: make(chan struct{})}
	toolCallSpoolIngests.passes[stateDir] = pass
	toolCallSpoolIngests.Unlock()
	pass.result = ingestToolCallSpoolsOnce(store, stateDir, days)
	close(pass.done)
	toolCallSpoolIngests.Lock()
	delete(toolCallSpoolIngests.passes, stateDir)
	toolCallSpoolIngests.Unlock()
	return pass.result
}

// toolCallSpoolDirs is every directory a lane's spool can be in, seen from the daemon: its own
// root and one per instance.
func toolCallSpoolDirs(stateDir string) []string {
	dirs := []string{filepath.Join(stateDir, TOOL_CALL_SPOOL_DIR)}
	entries, err := os.ReadDir(filepath.Join(stateDir, INSTANCES_DIR))
	if err != nil {
		return dirs
	}
	for _, entry := range entries {
		dirs = append(dirs, filepath.Join(stateDir, INSTANCES_DIR, entry.Name(), TOOL_CALL_SPOOL_DIR))
	}
	return dirs
}

// ingestToolCallSpoolsOnce reads every spool file once.
func ingestToolCallSpoolsOnce(store *TaskStore, stateDir string, keepDays int) int {
	ingested := 0
	for _, dir := range toolCallSpoolDirs(stateDir) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			file := filepath.Join(dir, name)
			info, err := entry.Info()
			if err != nil {
				continue
			}
			size := info.Size()
			recorded := store.ToolCallSpoolOffset(file)
			from := recorded
			if from > size {
				from = 0
			}
			if size > from {
				// BUG(port): TypeScript slices the decoded text with a byte offset. The port
				// reads the same bytes the offset counts, which agrees for ASCII samples.
				content, err := os.ReadFile(file)
				if err != nil {
					continue
				}
				chunk := string(content[int(from):])
				cut := strings.LastIndex(chunk, "\n")
				if cut >= 0 {
					consumed := chunk[:cut+1]
					for _, line := range strings.Split(consumed, "\n") {
						if strings.TrimSpace(line) == "" {
							continue
						}
						parsed := parseSpooledLine(line)
						if parsed == nil {
							continue
						}
						at := parsed.At
						store.RecordToolCall(ToolCallInput{
							InstanceID: parsed.InstanceId, Tool: parsed.Tool, Ms: float64(parsed.Ms),
							IsError: parsed.IsError, At: &at, Target: parsed.Target,
						})
						ingested++
					}
					store.SetToolCallSpoolOffset(file, from+int64(len(consumed)))
				}
			}
			// A fully consumed spool past the retention window is done with: the rows it
			// produced are pruned by the store on the same schedule.
			if store.ToolCallSpoolOffset(file) >= size && info.ModTime().Before(time.Now().Add(-time.Duration(keepDays)*24*time.Hour)) {
				_ = os.Remove(file)
				store.ForgetToolCallSpool(file)
			}
		}
	}
	return ingested
}

// ClearToolCallSpools removes every spool file: a cleared sample must not be re-ingested from disk.
func ClearToolCallSpools(stateDir string) {
	for _, dir := range toolCallSpoolDirs(stateDir) {
		_ = os.RemoveAll(dir)
	}
}
