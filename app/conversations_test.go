package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestParseConversationsSkipsArchived(t *testing.T) {
	list, err := parseConversations([]byte(`[
		{"id":"a","title":"第一个","status":"chatting","archivedAt":null},
		{"id":"b","title":"归档的","status":"archived","archivedAt":1794000000000}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Title != "第一个" {
		t.Fatalf("list %+v", list)
	}
	if list[0].ArchivedAtPresent() || !list[1].ArchivedAtPresent() {
		t.Fatal("archivedAt must decide what the list shows")
	}
	if _, err := parseConversations([]byte("{")); err == nil {
		t.Fatal("garbage must be reported")
	}
}

func TestParseConversationMessagesKeepsSpokenRolesOnly(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
		{"role":"user","text":"你好"},
		{"role":"tool","text":"{\"ok\":true}"},
		{"role":"assistant","kind":"chat","text":"**结论。**后文"},
		{"role":"assistant","text":"   "}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Text != "你好" || messages[1].Role != "assistant" {
		t.Fatalf("messages %+v", messages)
	}
}

func TestChatStateReadsTheDaemonAndRenders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "graph_session=tok" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[{"id":"c1","title":"会话一","status":"chatting","archivedAt":null}]`))
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"user","text":"你好"},{"role":"assistant","text":"**结论。**后文"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok\n")
	state.load()
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	if len(state.messages) != 2 {
		t.Fatalf("messages %+v", state.messages)
	}
	tester := ui.NewTester(state.view, 720, 620)
	if !tester.HasText("你好") {
		t.Fatalf("the user message is missing, texts %q", tester.Texts())
	}
	if !tester.HasText("结论。后文") {
		t.Fatalf("the markdown reply did not render, texts %q", tester.Texts())
	}
}

func TestChatStateReportsAnEmptyConversation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/conversations" {
			w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	state := newChatState(server.URL, "")
	state.load()
	if state.status != "还没有会话。" {
		t.Fatalf("status %q", state.status)
	}
}
