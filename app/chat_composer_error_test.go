package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type failingChatSource struct{ failures int }

func (source *failingChatSource) Key() string { return "c1" }
func (source *failingChatSource) Scope() chatScope {
	return chatScope{Kind: "conversation", ConversationID: "c1"}
}
func (source *failingChatSource) Capabilities() chatCapabilities {
	return chatCapabilities{ModelChip: true, Pause: true, History: true, Attachments: true}
}
func (source *failingChatSource) Load(c *chatState) error {
	source.failures++
	return errors.New("Get \"http://127.0.0.1:57970/api/conversations/c1\": connection refused")
}
func (source *failingChatSource) Refresh(c *chatState) (bool, error)   { return false, source.Load(c) }
func (source *failingChatSource) Send(c *chatState, text string) error { return nil }
func (source *failingChatSource) LoadOlder(c *chatState, before int64) ([]transcriptMessage, int64, bool, error) {
	return nil, 0, true, nil
}
func (source *failingChatSource) Follows() bool { return true }

// A chat read that fails is a connection problem, not a message from the Agent. Writing it
// into the composer made every reload print a red transport error where the user types, and
// the poll retries once a second so the text reappeared as fast as it could be dismissed.
func TestATransportFailureNeverEntersTheComposer(t *testing.T) {
	state := chatWithTwoMessages()
	state.source = &failingChatSource{}
	state.active = "c1"
	state.refresh()
	if state.problem != "" {
		t.Fatalf("a failed read must not occupy the composer, got %q", state.problem)
	}
	tester := frames(newTester(state.view, 900, 700))
	for _, text := range tester.Texts() {
		if strings.Contains(text, "读不到这个会话") || strings.Contains(text, "connection refused") {
			t.Fatalf("the transport error reached the chat surface: %q", text)
		}
	}
}

// The failure must still be visible somewhere: hiding it entirely would leave the user with a
// frozen transcript and no reason for it.
func TestATransportFailureIsReportedBesideTheChat(t *testing.T) {
	state := chatWithTwoMessages()
	state.source = &failingChatSource{}
	state.active = "c1"
	state.refresh()
	tester := frames(newTester(state.view, 900, 700))
	if !tester.HasText("连接中断") {
		t.Fatalf("the failure must be reported beside the chat, texts %q", tester.Texts())
	}
}

// Recovery matters more than the message: the first successful read must clear it, or a single
// reload leaves a permanent warning on a healthy conversation.
func TestASuccessfulReadClearsTheTransportFailure(t *testing.T) {
	state := chatWithTwoMessages()
	state.source = &failingChatSource{}
	state.active = "c1"
	state.refresh()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"messages":[{"id":"m1","seq":1,"role":"user","text":"问一句"}],"version":"v2"}`))
	}))
	defer server.Close()
	state.api = newAPIClient(server.URL, "")
	state.source = newConversationChatSource(state.api, "c1")
	state.refresh()
	tester := frames(newTester(state.view, 900, 700))
	if tester.HasText("连接中断") {
		t.Fatalf("a healthy read must clear the warning, texts %q", tester.Texts())
	}
}

// A failure the user caused must still reach the composer: a rejected send is their message
// and needs to stay where they can act on it.
func TestASendFailureStillReachesTheComposer(t *testing.T) {
	state := chatWithTwoMessages()
	state.failUser("发送失败：连接被拒绝")
	if state.problem != "发送失败：连接被拒绝" {
		t.Fatalf("a send failure belongs in the composer, got %q", state.problem)
	}
}

// The reload window is why this message showed up constantly: the daemon is briefly unreachable
// while it restarts, the poll retries once a second, and every retry used to rewrite the composer.
// The strip must describe that window as temporary and must vanish on the first answered read,
// so a healthy conversation never carries a stale warning.
func TestAReloadWindowLeavesNoLastingWarning(t *testing.T) {
	state := chatWithTwoMessages()
	state.source = &failingChatSource{}
	state.active = "c1"
	for attempt := 0; attempt < 3; attempt++ {
		state.refresh()
	}
	if state.problem != "" {
		t.Fatalf("repeated transport failures must stay out of the composer, got %q", state.problem)
	}
	if !strings.Contains(state.connection, "正在重连") {
		t.Fatalf("the strip must say the console is reconnecting, got %q", state.connection)
	}
	state.clearReadFailure()
	if state.connection != "" {
		t.Fatalf("the warning must clear once a read is answered, got %q", state.connection)
	}
}
