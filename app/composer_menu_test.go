package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func composerServer(t *testing.T) (*httptest.Server, chan string) {
	t.Helper()
	posted := make(chan string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/messages":
			payload := make([]byte, 8192)
			read, _ := r.Body.Read(payload)
			posted <- string(payload[:read])
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/api/conversations/c1":
			_, _ = w.Write([]byte(`{"id":"c1","projectId":"p1","projectRoot":"/tmp/p1","messages":[{"role":"assistant","text":"你好"}]}`))
		case r.URL.Path == "/api/projects/p1/entries":
			_, _ = w.Write([]byte(`{"entries":[{"path":"app","kind":"directory"},{"path":"app/graph.go","kind":"file"}]}`))
		case r.URL.Path == "/api/capabilities/config":
			_, _ = w.Write([]byte(`{"items":[{"id":"tdd-workflow","name":"tdd-workflow","kind":"skill","version":"1.2.0","ready":true}]}`))
		default:
			_, _ = w.Write([]byte(`{"messages":[{"role":"assistant","text":"你好"}]}`))
		}
	}))
	t.Cleanup(server.Close)
	return server, posted
}

func composerShell(t *testing.T) (*chatState, *ui.Tester) {
	t.Helper()
	server, _ := composerServer(t)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := frames(ui.NewTester(state.view, 760, 620))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) == 0 && time.Now().Before(deadline) {
		tester.Frame()
	}
	return state, tester
}

func TestTypingAMentionOpensThePathMenu(t *testing.T) {
	state, tester := composerShell(t)
	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	tester.Type("@")
	tester.Frame()
	tester.Frame()
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("app/graph.go") && time.Now().Before(deadline) {
		tester.Frame()
	}
	if !tester.HasText("app/graph.go") {
		t.Fatalf("the path menu lists the workspace files, texts %q", tester.Texts())
	}
	tester.Key(0, ui.KeyDown)
	tester.Frame()
	tester.Key(0, ui.KeyEnter)
	frames(tester)
	if !strings.Contains(state.draft, "[graph.go](app/graph.go)") {
		t.Fatalf("picking a file writes its link, draft %q", state.draft)
	}
}

func TestTypingADollarListsSkillsAndSkipsMoney(t *testing.T) {
	state, tester := composerShell(t)
	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	tester.Type("$")
	tester.Frame()
	tester.Frame()
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("tdd-workflow") && time.Now().Before(deadline) {
		tester.Frame()
	}
	if !tester.HasText("tdd-workflow") {
		t.Fatalf("the skill menu lists the skills, texts %q", tester.Texts())
	}
	if err := tester.Click("$tdd-workflow"); err != nil {
		t.Fatalf("pick the skill: %v", err)
	}
	frames(tester)
	if !strings.Contains(state.draft, "$tdd-workflow") {
		t.Fatalf("picking a skill writes its token, draft %q", state.draft)
	}
	state.draft = ""
	tester.Type("$5")
	tester.Frame()
	if state.menuTrigger != nil || tester.HasText("tdd-workflow") {
		t.Fatalf("money is not a skill trigger, trigger %+v", state.menuTrigger)
	}
}

func TestTypingASlashListsCommands(t *testing.T) {
	state, tester := composerShell(t)
	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	tester.Type("/")
	tester.Frame()
	if !tester.HasText("/clear") || !tester.HasText("/attach") {
		t.Fatalf("the command menu lists the commands, texts %q", tester.Texts())
	}
	tester.Key(0, ui.KeyEnter)
	frames(tester)
	if state.draft != "" {
		t.Fatalf("the clear command empties the draft, draft %q", state.draft)
	}
}

func TestAttachmentsShowAsChipsAndRideTheMessage(t *testing.T) {
	state, tester := composerShell(t)
	state.attachments = []composerAttachment{{Name: "notes.md", Type: "text/markdown", Size: 2048, Text: "记一笔"}}
	tester.Frame()
	if !tester.HasText("notes.md") || !tester.HasText("2.0 KB") {
		t.Fatalf("the attachment chip shows its name and size, texts %q", tester.Texts())
	}
	if err := tester.Click("移除附件 notes.md"); err != nil {
		t.Fatalf("remove the attachment: %v", err)
	}
	frames(tester)
	if len(state.attachments) != 0 {
		t.Fatalf("the chip removes its attachment, left %d", len(state.attachments))
	}
}

func TestSendingCarriesTheAttachments(t *testing.T) {
	server, posted := composerServer(t)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := frames(ui.NewTester(state.view, 760, 620))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) == 0 && time.Now().Before(deadline) {
		tester.Frame()
	}
	state.draft = "看一下这个文件"
	state.attachments = []composerAttachment{{Name: "notes.md", Type: "text/markdown", Size: 5, Text: "记一笔"}}
	tester.Frame()
	if err := tester.Click("发送"); err != nil {
		t.Fatalf("send the message: %v", err)
	}
	body := ""
	select {
	case body = <-posted:
	case <-time.After(2 * time.Second):
	}
	var payload struct {
		Text        string `json:"text"`
		Attachments []struct {
			Name string `json:"name"`
			Text string `json:"text"`
		} `json:"attachments"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("the message body is JSON: %v (%q)", err, body)
	}
	if payload.Text != "看一下这个文件" || len(payload.Attachments) != 1 || payload.Attachments[0].Name != "notes.md" || payload.Attachments[0].Text != "记一笔" {
		t.Fatalf("the message carries the attachment, body %+v", payload)
	}
	deadline = time.Now().Add(2 * time.Second)
	for len(state.attachments) != 0 && time.Now().Before(deadline) {
		tester.Frame()
	}
	if len(state.attachments) != 0 {
		t.Fatalf("sending clears the attachments, left %d", len(state.attachments))
	}
}

func TestAttachingAFileReadsItsText(t *testing.T) {
	path := t.TempDir() + "/notes.md"
	if err := os.WriteFile(path, []byte("附件内容"), 0o600); err != nil {
		t.Fatalf("write the attachment: %v", err)
	}
	attachment, err := composerAttachmentFromPath(path)
	if err != nil {
		t.Fatalf("read the attachment: %v", err)
	}
	if attachment.Name != "notes.md" || attachment.Type != "text/markdown" || attachment.Text != "附件内容" {
		t.Fatalf("the attachment carries its file, got %+v", attachment)
	}
	if _, err := composerAttachmentFromPath(t.TempDir()); err == nil {
		t.Fatal("a directory is not attachable")
	}
}
