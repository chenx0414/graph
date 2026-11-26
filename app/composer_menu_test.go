package main

import (
	"encoding/base64"
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
	tester := frames(newTester(state.view, 760, 620))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) == 0 && time.Now().Before(deadline) {
		render(tester)
	}
	return state, tester
}

func TestTypingAMentionOpensThePathMenu(t *testing.T) {
	state, tester := composerShell(t)
	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	tester.Type("@")
	render(tester)
	render(tester)
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("app/graph.go") && time.Now().Before(deadline) {
		render(tester)
	}
	if !tester.HasText("app/graph.go") {
		t.Fatalf("the path menu lists the workspace files, texts %q", tester.Texts())
	}
	tester.Key(0, ui.KeyDown)
	render(tester)
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
	render(tester)
	render(tester)
	deadline := time.Now().Add(2 * time.Second)
	for !tester.HasText("tdd-workflow") && time.Now().Before(deadline) {
		render(tester)
	}
	if !tester.HasText("tdd-workflow") {
		t.Fatalf("the skill menu lists the skills, texts %q", tester.Texts())
	}
	if err := tester.Click("$tdd-workflow"); err != nil {
		t.Fatalf("pick the skill: %v", err)
	}
	frames(tester)
	if !strings.Contains(state.draft, "/skill:tdd-workflow") {
		t.Fatalf("picking a skill writes the kernel skill token, draft %q", state.draft)
	}
	state.draft = ""
	tester.Type("$5")
	render(tester)
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
	render(tester)
	if !tester.HasText("/new") || !tester.HasText("/attach") {
		t.Fatalf("the command menu lists the commands, texts %q", tester.Texts())
	}
	if tester.HasText("/clear") {
		t.Fatalf("the retired clear command is gone, texts %q", tester.Texts())
	}
	tester.Key(0, ui.KeyEnter)
	frames(tester)
	if state.draft != "" {
		t.Fatalf("the new command empties the typed command, draft %q", state.draft)
	}
}

func TestAttachmentsShowAsChipsAndRideTheMessage(t *testing.T) {
	state, tester := composerShell(t)
	state.attachments = []composerAttachment{{Name: "notes.md", Type: "text/markdown", Size: 2048, Text: "记一笔"}}
	render(tester)
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
	tester := frames(newTester(state.view, 760, 620))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) == 0 && time.Now().Before(deadline) {
		render(tester)
	}
	state.draft = "看一下这个文件"
	state.attachments = []composerAttachment{{Name: "notes.md", Type: "text/markdown", Size: 5, Text: "记一笔"}}
	render(tester)
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
		render(tester)
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

const composerTinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func TestAttachingAnImageKeepsItsBytes(t *testing.T) {
	path := t.TempDir() + "/photo.png"
	data, err := base64.StdEncoding.DecodeString(composerTinyPNG)
	if err != nil {
		t.Fatalf("decode the fixture: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write the image: %v", err)
	}
	attachment, err := composerAttachmentFromPath(path)
	if err != nil {
		t.Fatalf("read the image: %v", err)
	}
	if !attachment.isImage() || attachment.Type != "image/png" || attachment.Text != "" || attachment.Data == "" {
		t.Fatalf("the image attachment carries its bytes, got %+v", attachment)
	}
}

func TestSendingAnImageCarriesItsBase64Data(t *testing.T) {
	server, posted := composerServer(t)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := frames(newTester(state.view, 760, 620))
	deadline := time.Now().Add(2 * time.Second)
	for len(state.messages) == 0 && time.Now().Before(deadline) {
		render(tester)
	}
	state.draft = "看这张图"
	state.attachments = []composerAttachment{{Name: "photo.png", Type: "image/png", Size: 70, Data: composerTinyPNG}}
	render(tester)
	if err := tester.Click("发送"); err != nil {
		t.Fatalf("send the message: %v", err)
	}
	body := ""
	select {
	case body = <-posted:
	case <-time.After(2 * time.Second):
	}
	var payload struct {
		Attachments []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Data string `json:"data"`
		} `json:"attachments"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("the message body is JSON: %v (%q)", err, body)
	}
	if len(payload.Attachments) != 1 || payload.Attachments[0].Data != composerTinyPNG || payload.Attachments[0].Type != "image/png" {
		t.Fatalf("the image rides the message as base64, body %+v", payload)
	}
}

func TestAnImageAttachmentRendersItsThumbnail(t *testing.T) {
	state, tester := composerShell(t)
	state.attachments = []composerAttachment{{Name: "photo.png", Type: "image/png", Size: 70, Data: composerTinyPNG}}
	render(tester)
	if !tester.HasText("photo.png") || !tester.HasText("附件图片 photo.png") {
		t.Fatalf("the image chip shows its thumbnail and name, texts %q", tester.Texts())
	}
}

func TestSlashNewStartsAFreshAgentContext(t *testing.T) {
	requests := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/conversations/c1/new-context" {
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			requests <- string(payload[:read])
			_, _ = w.Write([]byte(`{"conversationId":"c1","reset":true}`))
			return
		}
		if r.URL.Path == "/api/conversations/c1" {
			_, _ = w.Write([]byte(`{"id":"c1","messages":[{"role":"assistant","text":"旧上下文"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	tester := frames(newTester(state.view, 760, 620))
	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	tester.Type("/new")
	render(tester)
	if !tester.HasText("/new") {
		t.Fatalf("the menu offers /new, texts %q", tester.Texts())
	}
	tester.Key(0, ui.KeyEnter)
	deadline := time.Now().Add(2 * time.Second)
	for state.status != "已开启新的 Agent 上下文" && time.Now().Before(deadline) {
		render(tester)
	}
	if state.status != "已开启新的 Agent 上下文" {
		t.Fatalf("the command reports the fresh context, status %q", state.status)
	}
	if len(requests) == 0 {
		t.Fatalf("the command resets the agent context, status %q", state.status)
	}
}
