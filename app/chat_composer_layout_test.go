package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func chatWithTwoMessages() *chatState {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = []transcriptMessage{
		{ID: "m1", Seq: 1, Role: "user", Kind: "chat", Text: "问一句", State: "delivered"},
		{ID: "m2", Seq: 2, Role: "assistant", Kind: "chat", Text: "答一句", State: "done"},
	}
	return state
}

func TestTheChatShowsNoStatusLineAboveTheComposer(t *testing.T) {
	state := chatWithTwoMessages()
	tester := frames(newTester(state.view, 900, 700))
	quiet := tester.Texts()
	state.status = "读不到更早的对话：json: cannot unmarshal string into Go struct field"
	tester = frames(tester)
	loud := tester.Texts()
	if len(loud) != len(quiet) {
		t.Fatalf("a status adds no text node to the chat, %q against %q", loud, quiet)
	}
	for index := range quiet {
		if quiet[index] != loud[index] {
			t.Fatalf("a status changes no text node of the chat, %q against %q", loud, quiet)
		}
	}
}

func TestAFailedOlderReadReadsBesideTheChatNotInTheComposer(t *testing.T) {
	state := chatWithTwoMessages()
	tester := frames(newTester(state.view, 900, 700))
	quiet, ok := tester.Access("消息")
	if !ok {
		t.Fatalf("the composer is on screen, texts %q", tester.Texts())
	}
	if !strings.HasPrefix(quiet.Placeholder, "想问什么") {
		t.Fatalf("a quiet chat shows its prompt hint, got %q", quiet.Placeholder)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/conversations/c1/history") {
			_, _ = w.Write([]byte("不是 JSON"))
			return
		}
		_, _ = w.Write([]byte(`{"messages":[{"id":"m1","seq":1,"role":"user","text":"问一句"}]}`))
	}))
	t.Cleanup(server.Close)
	state.api = newAPIClient(server.URL, "")
	state.source = newConversationChatSource(state.api, "c1")
	state.active = "c1"
	state.oldestSeq = 1
	state.noMoreHistory = false
	state.ensureHistory()
	for attempt := 0; attempt < 200 && state.historyLoading; attempt++ {
		render(tester)
	}
	if state.status == "" {
		t.Fatalf("a failed read still records what went wrong, got %q", state.status)
	}
	tester = frames(tester)
	// A read failure is a transport fact: it belongs beside the chat, never in the composer,
	// where the user types and where the one-second poll kept rewriting it.
	if state.problem != "" {
		t.Fatalf("a read failure must not occupy the composer, got %q", state.problem)
	}
	if !tester.HasText("读不到更早的对话，正在重试") {
		t.Fatalf("the failure must stay visible beside the chat, texts %q", tester.Texts())
	}
	access, ok := tester.Access("消息")
	if !ok {
		t.Fatalf("the composer is on screen, texts %q", tester.Texts())
	}
	if access.Placeholder != "想问什么？  @ 文件，$ 技能，/ 命令" {
		t.Fatalf("the failure leaves the prompt hint alone, got %q", access.Placeholder)
	}
}

func TestTheComposerStartsTwoLinesTall(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	tester := frames(newTester(state.view, 900, 700))
	empty, ok := tester.Find("消息")
	if !ok {
		t.Fatalf("the composer is on screen, texts %q", tester.Texts())
	}
	state.draft = "第一行\n第二行"
	tester = frames(tester)
	two, ok := tester.Find("消息")
	if !ok {
		t.Fatalf("the field stays on screen while typing, texts %q", tester.Texts())
	}
	if two.H != empty.H {
		t.Fatalf("an empty field already fits two lines, got %.2f and %.2f", empty.H, two.H)
	}
	state.draft = "第一行\n第二行\n第三行"
	tester = frames(tester)
	three, ok := tester.Find("消息")
	if !ok {
		t.Fatalf("the field stays on screen while typing, texts %q", tester.Texts())
	}
	if three.H <= empty.H {
		t.Fatalf("a third line grows the field, got %.2f from %.2f", three.H, empty.H)
	}
	send, ok := tester.Find("发送")
	if !ok {
		t.Fatalf("the send button is on screen, texts %q", tester.Texts())
	}
	if bottom := send.Y + send.H; bottom > 700 {
		t.Fatalf("the composer stays inside the window, bottom %.2f", bottom)
	}
}

func TestAFailureStaysVisibleWhileTheComposerHoldsADraft(t *testing.T) {
	state := chatWithTwoMessages()
	state.connection = "读不到更早的对话，正在重试"
	state.draft = "还没发出去的一句话"
	tester := frames(newTester(state.view, 900, 700))
	if !tester.HasText("读不到更早的对话，正在重试") {
		t.Fatalf("a failure must stay readable even when the composer holds a draft, texts %q", tester.Texts())
	}
	field, ok := tester.Access("消息")
	if !ok {
		t.Fatalf("the composer is on screen, texts %q", tester.Texts())
	}
	if field.Placeholder != "想问什么？  @ 文件，$ 技能，/ 命令" {
		t.Fatalf("the placeholder keeps the prompt hint, got %q", field.Placeholder)
	}
}
