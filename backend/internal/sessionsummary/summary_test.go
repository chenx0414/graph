package sessionsummary

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSession(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write session: %v", err)
	}
	return path
}

const metaLine = `{"timestamp":"2026-11-04T19:02:51.000Z","type":"session_meta","payload":{"id":"01a1","session_id":"01a0","parent_thread_id":"parent-1","cwd":"/work","git":{"branch":"main","commit_hash":"abc123"}}}`

func userLine(timestamp, text string) string {
	return `{"timestamp":"` + timestamp + `","type":"response_item","payload":{"type":"message","role":"user","content":[{"text":` + quote(text) + `}]}}`
}

func assistantLine(timestamp, text string) string {
	return `{"timestamp":"` + timestamp + `","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":` + quote(text) + `}]}}`
}

func quote(text string) string {
	encoded := &bytes.Buffer{}
	encoded.WriteByte('"')
	for _, character := range text {
		switch character {
		case '"':
			encoded.WriteString(`\"`)
		case '\\':
			encoded.WriteString(`\\`)
		case '\n':
			encoded.WriteString(`\n`)
		case '\t':
			encoded.WriteString(`\t`)
		default:
			encoded.WriteRune(character)
		}
	}
	encoded.WriteByte('"')
	return encoded.String()
}

func callLine(timestamp, callID, command string) string {
	return `{"timestamp":"` + timestamp + `","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"` + callID + `","arguments":` + quote(`{"cmd":"`+command+`"}`) + `}}`
}

func outputLine(timestamp, callID, output string) string {
	return `{"timestamp":"` + timestamp + `","type":"response_item","payload":{"type":"function_call_output","call_id":"` + callID + `","output":` + quote(output) + `}}`
}

func TestSummarizeReportsTheSessionStory(t *testing.T) {
	path := writeSession(t,
		metaLine,
		userLine("2026-11-04T19:03:00.000Z", "# AGENTS.md instructions for /work\n\nignored"),
		userLine("2026-11-04T19:03:01.000Z", "<app-context>ignored</app-context>"),
		userLine("2026-11-04T19:03:02.000Z", "prefix\n## My request:\n  add the thing  \n"),
		assistantLine("2026-11-04T19:03:03.000Z", "I will add the thing."),
		callLine("2026-11-04T19:03:04.000Z", "call-1", "go test ./..."),
		outputLine("2026-11-04T19:03:05.000Z", "call-1", "FAIL\nProcess exited with code 1"),
		callLine("2026-11-04T19:03:06.000Z", "call-2", "git status --short"),
		outputLine("2026-11-04T19:03:07.000Z", "call-2", "## main...origin/main\n M a.go"),
		callLine("2026-11-04T19:03:08.000Z", "call-3", "true"),
		outputLine("2026-11-04T19:03:09.000Z", "call-3", "Exit code: 0"),
	)
	report, err := Summarize(path)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if report.Meta.ID != "01a1" || report.Meta.SessionID != "01a0" || report.Meta.ParentThreadID != "parent-1" || report.Meta.Branch != "main" || report.Meta.Commit != "abc123" {
		t.Fatalf("meta = %+v", report.Meta)
	}
	if len(report.Requests) != 1 || report.Requests[0] != "add the thing" {
		t.Fatalf("requests = %v", report.Requests)
	}
	if report.Commands != 3 || report.TotalFailed != 1 || report.Failed[0] != "exit 1: go test ./..." {
		t.Fatalf("commands = %d, failed = %v", report.Commands, report.Failed)
	}
	if report.GitStatus != "## main...origin/main" {
		t.Fatalf("git status = %q", report.GitStatus)
	}
	if report.LastAssistant != "I will add the thing." {
		t.Fatalf("last assistant = %q", report.LastAssistant)
	}

	rendered := &bytes.Buffer{}
	Render(rendered, report)
	want := []string{
		"Session",
		"  id: 01a1",
		"  root_session: 01a0",
		"  parent: parent-1",
		"  cwd: /work",
		"  git: main @ abc123",
		"  range: 2026-11-04T19:02:51.000Z -> 2026-11-04T19:03:09.000Z",
		"\nUser requests",
		"  - add the thing",
		"\nCommands",
		"  total: 3",
		"  failed: 1",
		"  - exit 1: go test ./...",
		"\nFinal repository state",
		"  ## main...origin/main",
		"\nLast assistant message",
		"  I will add the thing.",
	}
	for _, line := range want {
		if !strings.Contains(rendered.String(), line) {
			t.Errorf("rendered output is missing %q\n%s", line, rendered.String())
		}
	}
}

func TestSummarizeTruncatesLongTextAndKeepsTheTail(t *testing.T) {
	long := strings.Repeat("a", 300)
	path := writeSession(t, metaLine, userLine("2026-11-04T19:03:00.000Z", long))
	report, err := Summarize(path)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if len(report.Requests[0]) != 240 || !strings.HasSuffix(report.Requests[0], "...") {
		t.Fatalf("request = %q (length %d)", report.Requests[0], len(report.Requests[0]))
	}

	many := []string{metaLine}
	for index := 0; index < 35; index++ {
		many = append(many, userLine("2026-11-04T19:03:00.000Z", "request "+string(rune('a'+index%26))))
	}
	report, err = Summarize(writeSession(t, many...))
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if report.TotalRequests != 35 {
		t.Fatalf("total requests = %d", report.TotalRequests)
	}
	rendered := &bytes.Buffer{}
	Render(rendered, report)
	if !strings.Contains(rendered.String(), "(5 earlier requests omitted)") {
		t.Fatalf("rendered output is missing the omission line\n%s", rendered.String())
	}
}

func TestSummarizeCollapsesWhitespaceInCommands(t *testing.T) {
	path := writeSession(t, metaLine,
		`{"timestamp":"2026-11-04T19:03:04.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"command\":\"npm   run  build\"}"}}`,
		`{"timestamp":"2026-11-04T19:03:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"Exit code: 2"}}`,
	)
	report, err := Summarize(path)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if len(report.Failed) != 1 || report.Failed[0] != "exit 2: npm run build" {
		t.Fatalf("failed = %v", report.Failed)
	}
}

func TestSummarizeIgnoresUnparsableLines(t *testing.T) {
	path := writeSession(t, "not json", metaLine, "")
	report, err := Summarize(path)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if report.Meta.ID != "01a1" || report.Commands != 0 {
		t.Fatalf("report = %+v", report)
	}
}

func TestNewestSessionPicksTheMostRecentJSONL(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "2026", "11", "04")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	older := filepath.Join(nested, "older.jsonl")
	newer := filepath.Join(nested, "newer.jsonl")
	if err := os.WriteFile(older, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("write older: %v", err)
	}
	if err := os.WriteFile(newer, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("write newer: %v", err)
	}
	if err := os.Chtimes(older, testTime(1), testTime(1)); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	if err := os.Chtimes(newer, testTime(2), testTime(2)); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	path, found := NewestSession(root)
	if !found || path != newer {
		t.Fatalf("newest = %q, found = %v", path, found)
	}
	if _, found := NewestSession(filepath.Join(root, "missing")); found {
		t.Fatal("a missing root must not report a session")
	}
}

func testTime(second int64) time.Time {
	return time.Unix(1_700_000_000+second, 0)
}
