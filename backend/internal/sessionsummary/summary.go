package sessionsummary

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

var (
	exitPattern   = regexp.MustCompile(`(?:Process exited with code|Exit code:)\s*(-?\d+)`)
	statusPattern = regexp.MustCompile(`(?:^|\n)(## [^\n]+)`)
	spacePattern  = regexp.MustCompile(`\s+`)
	skipPrefixes  = []string{"# AGENTS.md instructions", "<app-context>", "<subagent_notification>", "<skill>"}
)

type Report struct {
	Meta          Meta
	FirstAt       string
	LastAt        string
	Requests      []string
	TotalRequests int
	Commands      int
	Failed        []string
	TotalFailed   int
	GitStatus     string
	LastAssistant string
}

type Meta struct {
	ID             string
	SessionID      string
	ParentThreadID string
	ForkedFromID   string
	Cwd            string
	Branch         string
	Commit         string
}

type contentPart struct {
	Text *string `json:"text"`
}

type payload struct {
	Type           string          `json:"type"`
	Role           string          `json:"role"`
	Content        []contentPart   `json:"content"`
	Name           string          `json:"name"`
	CallID         string          `json:"call_id"`
	Arguments      json.RawMessage `json:"arguments"`
	Output         string          `json:"output"`
	ID             string          `json:"id"`
	SessionID      string          `json:"session_id"`
	ParentThreadID string          `json:"parent_thread_id"`
	ForkedFromID   string          `json:"forked_from_id"`
	Cwd            string          `json:"cwd"`
	Git            struct {
		Branch     string `json:"branch"`
		CommitHash string `json:"commit_hash"`
	} `json:"git"`
}

type record struct {
	Timestamp string  `json:"timestamp"`
	Type      string  `json:"type"`
	Payload   payload `json:"payload"`
}

func Summarize(path string) (Report, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return Report{}, err
	}
	report := Report{Meta: Meta{ID: "unknown", Cwd: "unknown"}}
	commands := map[string]string{}
	for _, line := range strings.Split(string(body), "\n") {
		var current record
		if json.Unmarshal([]byte(line), &current) != nil {
			continue
		}
		if current.Timestamp != "" {
			if report.FirstAt == "" {
				report.FirstAt = current.Timestamp
			}
			report.LastAt = current.Timestamp
		}
		if current.Type == "session_meta" {
			report.Meta = metaOf(current.Payload)
			continue
		}
		if current.Type != "response_item" {
			continue
		}
		item := current.Payload
		switch {
		case item.Type == "message" && item.Role == "user":
			if request := userRequest(messageText(item.Content)); request != "" {
				report.Requests = append(report.Requests, compact(request, 240))
			}
		case item.Type == "message" && item.Role == "assistant":
			if text := messageText(item.Content); text != "" {
				report.LastAssistant = compact(text, 320)
			}
		case item.Type == "function_call" && item.Name == "exec_command":
			report.Commands++
			commands[item.CallID] = commandText(item.Arguments)
		case item.Type == "function_call_output":
			command, known := commands[item.CallID]
			if !known {
				command = "unknown command"
			}
			if exit := exitPattern.FindStringSubmatch(item.Output); exit != nil {
				if code, convErr := strconv.Atoi(exit[1]); convErr == nil && code != 0 {
					report.Failed = append(report.Failed, "exit "+exit[1]+": "+command)
				}
			}
			if strings.Contains(command, "git status") {
				if status := statusPattern.FindStringSubmatch(item.Output); status != nil {
					report.GitStatus = status[1]
				}
			}
		}
	}
	report.TotalRequests = len(report.Requests)
	report.TotalFailed = len(report.Failed)
	return report, nil
}

func metaOf(item payload) Meta {
	meta := Meta{ID: item.ID, SessionID: item.SessionID, ParentThreadID: item.ParentThreadID, ForkedFromID: item.ForkedFromID, Cwd: item.Cwd, Branch: item.Git.Branch, Commit: item.Git.CommitHash}
	if meta.ID == "" {
		meta.ID = "unknown"
	}
	if meta.Cwd == "" {
		meta.Cwd = "unknown"
	}
	return meta
}

func messageText(parts []contentPart) string {
	texts := []string{}
	for _, part := range parts {
		if part.Text != nil && *part.Text != "" {
			texts = append(texts, *part.Text)
		}
	}
	return strings.Join(texts, "\n")
}

func userRequest(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	for _, prefix := range skipPrefixes {
		if strings.HasPrefix(trimmed, prefix) {
			return ""
		}
	}
	if marker := strings.Index(text, "## My request:"); marker >= 0 {
		return strings.TrimSpace(text[marker+len("## My request:"):])
	}
	return strings.TrimSpace(text)
}

func commandText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			trimmed = text
		}
	}
	var object map[string]any
	if json.Unmarshal([]byte(trimmed), &object) == nil {
		for _, key := range []string{"cmd", "command", "path"} {
			if value, ok := object[key]; ok && value != nil {
				return compact(toText(value), 240)
			}
		}
	}
	return compact(trimmed, 240)
}

func toText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func compact(text string, max int) string {
	oneLine := strings.TrimSpace(spacePattern.ReplaceAllString(text, " "))
	units := utf16.Encode([]rune(oneLine))
	if len(units) <= max {
		return oneLine
	}
	return string(utf16.Decode(units[:max-3])) + "..."
}

func Render(writer io.Writer, report Report) {
	write := func(line string) { _, _ = io.WriteString(writer, line+"\n") }
	write("Session")
	write("  id: " + report.Meta.ID)
	if report.Meta.SessionID != "" && report.Meta.SessionID != report.Meta.ID {
		write("  root_session: " + report.Meta.SessionID)
	}
	if report.Meta.ParentThreadID != "" {
		write("  parent: " + report.Meta.ParentThreadID)
	}
	if report.Meta.ForkedFromID != "" {
		write("  forked_from: " + report.Meta.ForkedFromID)
	}
	write("  cwd: " + report.Meta.Cwd)
	if report.Meta.Branch != "" || report.Meta.Commit != "" {
		branch, commit := report.Meta.Branch, report.Meta.Commit
		if branch == "" {
			branch = "unknown"
		}
		if commit == "" {
			commit = "unknown"
		}
		write("  git: " + branch + " @ " + commit)
	}
	write("  range: " + orUnknown(report.FirstAt) + " -> " + orUnknown(report.LastAt))

	write("\nUser requests")
	if len(report.Requests) == 0 {
		write("  (none found)")
	}
	for _, request := range tail(report.Requests, 30) {
		write("  - " + request)
	}
	if report.TotalRequests > 30 {
		write("  (" + strconv.Itoa(report.TotalRequests-30) + " earlier requests omitted)")
	}

	write("\nCommands")
	write("  total: " + strconv.Itoa(report.Commands))
	write("  failed: " + strconv.Itoa(report.TotalFailed))
	for _, failure := range tail(report.Failed, 12) {
		write("  - " + failure)
	}
	if report.TotalFailed > 12 {
		write("  (" + strconv.Itoa(report.TotalFailed-12) + " earlier failures omitted)")
	}

	write("\nFinal repository state")
	if report.GitStatus == "" {
		write("  (no git status output found)")
	} else {
		write("  " + report.GitStatus)
	}

	write("\nLast assistant message")
	if report.LastAssistant == "" {
		write("  (none found)")
	} else {
		write("  " + report.LastAssistant)
	}
}

func orUnknown(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}

func tail(values []string, count int) []string {
	if len(values) <= count {
		return values
	}
	return values[len(values)-count:]
}

func NewestSession(root string) (string, bool) {
	newest, newestTime := "", int64(-1)
	var walk func(directory string)
	walk = func(directory string) {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		for _, entry := range entries {
			path := filepath.Join(directory, entry.Name())
			if entry.IsDir() {
				walk(path)
				continue
			}
			if !strings.HasSuffix(entry.Name(), ".jsonl") {
				continue
			}
			info, statErr := entry.Info()
			if statErr != nil {
				continue
			}
			if info.ModTime().UnixNano() > newestTime {
				newest, newestTime = path, info.ModTime().UnixNano()
			}
		}
	}
	walk(root)
	return newest, newest != ""
}
