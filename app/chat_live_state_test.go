package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMessageHelpersReadTheBackendStateVocabulary(t *testing.T) {
	if !messageStreaming(transcriptMessage{Role: "assistant", State: "running"}) {
		t.Fatal("the backend streams replies as running")
	}
	if !messageStreaming(transcriptMessage{Role: "assistant", State: "streaming"}) {
		t.Fatal("the legacy streaming state still renders live")
	}
	if messageStreaming(transcriptMessage{Role: "assistant", State: "done"}) {
		t.Fatal("a settled reply must render as a finished view")
	}
	if messageStreaming(transcriptMessage{Role: "user", State: "running"}) {
		t.Fatal("only assistant messages render with Stream")
	}
	if !messageQueued(transcriptMessage{Role: "user", State: "queued"}) {
		t.Fatal("a queued user message can be cancelled")
	}
	if messageQueued(transcriptMessage{Role: "assistant", State: "queued"}) {
		t.Fatal("only a user message is queued for delivery")
	}
	for _, state := range []string{"queued", "pending", "running", "streaming"} {
		if !messageActive(transcriptMessage{Role: "tool", State: state}) {
			t.Fatalf("tool state %q is still active", state)
		}
	}
	if messageActive(transcriptMessage{Role: "user", State: "delivered"}) {
		t.Fatal("a delivered prompt is history, not active work")
	}
	if messageActive(transcriptMessage{Role: "assistant", State: "done"}) {
		t.Fatal("a settled reply is not active work")
	}
}

func TestConversationStreamsRenderAsALiveReply(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/conversations/c1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(`{"paused":false,"messages":[{"id":"u1","seq":1,"role":"user","text":"问","state":"delivered"}],"streams":[
			{"operationId":"op1","entryId":"entry-1","partId":"0","ordinal":1,"text":"半","updatedAt":10},
			{"operationId":"op1","entryId":"entry-1","partId":"1","ordinal":2,"text":"句","updatedAt":11}
		]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.messages) != 2 {
		t.Fatalf("a live stream is one assistant row, messages %+v", state.messages)
	}
	live := state.messages[1]
	if live.Role != "assistant" || live.State != "streaming" || live.Text != "半句" {
		t.Fatalf("the live row is %+v", live)
	}
	if !state.busy() {
		t.Fatal("a running reply means the round is busy")
	}
	if state.composerMode() != composerPause {
		t.Fatalf("a running reply must offer pause, mode %v", state.composerMode())
	}
}

func TestTheLiveReplyYieldsToTheSettledMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/conversations/c1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(`{"messages":[
			{"id":"u1","seq":1,"role":"user","text":"问","state":"delivered"},
			{"id":"a1","seq":2,"role":"assistant","text":"完整答复","state":"done","operationId":"op1"}
		],"streams":[{"operationId":"op1","entryId":"entry-1","partId":"0","ordinal":1,"text":"半","updatedAt":10}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.messages) != 2 || state.messages[1].Text != "完整答复" || state.messages[1].State != "done" {
		t.Fatalf("the settled reply replaces its stream, messages %+v", state.messages)
	}
	if state.busy() {
		t.Fatal("a settled reply is no longer busy")
	}
}

func TestASettledUserMessageDoesNotHoldTheRoundOpen(t *testing.T) {
	state := &chatState{
		roundMaster: "done",
		messages: []transcriptMessage{
			{Role: "user", Text: "问", State: "delivered"},
			{Role: "assistant", Text: "完整答复", State: "done"},
		},
	}
	if state.busy() {
		t.Fatal("a delivered prompt is history, not a running round")
	}
}

func TestAQueuedPromptBehindARunningRoundKeepsThePauseAction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/conversations/c1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(`{"paused":false,"master":{"status":"running"},"messages":[{"id":"u1","seq":1,"role":"user","text":"等下一轮","state":"queued"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if !state.busy() || state.composerMode() != composerPause {
		t.Fatalf("a queued prompt behind a running round is work to pause, busy %v mode %v", state.busy(), state.composerMode())
	}
}

func TestALiveReplyUpdatesInPlace(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/conversations/c1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		text := "半"
		if calls > 0 {
			text = "半句"
		}
		calls++
		w.Write([]byte(`{"paused":false,"messages":[{"id":"u1","seq":1,"role":"user","text":"问","state":"delivered"}],"streams":[
			{"operationId":"op1","entryId":"entry-1","partId":"0","ordinal":1,"text":"` + text + `","updatedAt":10}
		]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	state.refresh()
	if len(state.messages) != 2 {
		t.Fatalf("refreshing must not append a second live row, messages %+v", state.messages)
	}
	if state.messages[1].Text != "半句" {
		t.Fatalf("the live row keeps the newest text, got %q", state.messages[1].Text)
	}
}
