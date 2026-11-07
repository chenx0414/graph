package graph

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"encoding/json"
)

const TOOL_CALL_SPOOL_DIR = "tool-calls"

const INSTANCES_DIR = "instances"

const TOOL_CALL_SPOOL_RETAIN_DAYS = 90

type ToolCallSpoolCall struct {
	Tool    string
	Ms      float64
	IsError bool
	Target  *string
}

type toolCallSpoolLine struct {
	InstanceId string  `json:"instanceId"`
	Tool       string  `json:"tool"`
	Ms         int64   `json:"ms"`
	IsError    bool    `json:"isError"`
	At         int64   `json:"at"`
	Target     *string `json:"target,omitempty"`
}

func ToolCallSpoolPath(stateDir string, instanceId string) string {
	return filepath.Join(stateDir, TOOL_CALL_SPOOL_DIR, toolCallSpoolFileName(instanceId)+".jsonl")
}

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

func SpoolToolCall(stateDir string, instanceId string, call ToolCallSpoolCall) {
	defer func() {
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

type toolCallSpoolPass struct {
	done   chan struct{}
	result int
}

var toolCallSpoolIngests = struct {
	sync.Mutex
	passes map[string]*toolCallSpoolPass
}{passes: map[string]*toolCallSpoolPass{}}

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
			if store.ToolCallSpoolOffset(file) >= size && info.ModTime().Before(time.Now().Add(-time.Duration(keepDays)*24*time.Hour)) {
				_ = os.Remove(file)
				store.ForgetToolCallSpool(file)
			}
		}
	}
	return ingested
}

func ClearToolCallSpools(stateDir string) {
	for _, dir := range toolCallSpoolDirs(stateDir) {
		_ = os.RemoveAll(dir)
	}
}
