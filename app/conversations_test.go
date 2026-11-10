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
	if len(messages) != 3 || messages[0].Text != "你好" || messages[1].Role != "tool" || messages[2].Role != "assistant" {
		t.Fatalf("tool messages must survive parsing so the view can show them: %+v", messages)
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

func TestChatStateSendsAndReadsTheAnswerBack(t *testing.T) {
	posted := ""
	sent := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/messages":
			payload := make([]byte, 1024)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			sent = true
			w.Write([]byte(`{"accepted":true}`))
		case r.URL.Path == "/api/conversations/c1":
			if sent {
				w.Write([]byte(`{"messages":[{"role":"user","text":"再来一句"},{"role":"assistant","text":"答复到了"}]}`))
				return
			}
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"旧的"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if state.active != "c1" || state.status != "" {
		t.Fatalf("active %q status %q", state.active, state.status)
	}
	state.draft = "再来一句"
	state.send()
	if posted == "" || !contains(posted, "再来一句") || !contains(posted, "requestId") {
		t.Fatalf("posted body %q", posted)
	}
	if state.draft != "" {
		t.Fatal("the composer must clear after a send")
	}
	if len(state.messages) != 2 || state.messages[1].Text != "答复到了" {
		t.Fatalf("messages %+v", state.messages)
	}
	if state.status != "" {
		t.Fatalf("status %q after the answer arrived", state.status)
	}
}

func TestChatStateKeepsAStatusWhileTheAnswerIsPending(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Write([]byte(`{}`))
			return
		}
		w.Write([]byte(`{"messages":[{"role":"user","text":"发出去的"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	state.draft = "发出去的"
	state.send()
	if state.status != "已发出，等待回复…" {
		t.Fatalf("status %q", state.status)
	}
}

func contains(haystack, needle string) bool {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestMessageStreamingFollowsTheStateField(t *testing.T) {
	if !messageStreaming(transcriptMessage{Role: "assistant", State: "streaming"}) {
		t.Fatal("a streaming assistant message must render with Stream")
	}
	if messageStreaming(transcriptMessage{Role: "assistant", State: "done"}) {
		t.Fatal("a finished reply must render with View")
	}
	if messageStreaming(transcriptMessage{Role: "user", State: "streaming"}) {
		t.Fatal("only assistant messages stream")
	}
}

func TestFollowStopsWhenTheReplyLands(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.Write([]byte(`{"messages":[{"role":"user","text":"问"},{"role":"assistant","state":"streaming","text":"半句"}]}`))
			return
		}
		w.Write([]byte(`{"messages":[{"role":"user","text":"问"},{"role":"assistant","state":"done","text":"完整答复"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.active = "c1"
	state.follow()
	if calls < 3 {
		t.Fatalf("the follower stopped too early (%d polls)", calls)
	}
	if len(state.messages) != 2 || state.messages[1].Text != "完整答复" {
		t.Fatalf("messages %+v", state.messages)
	}
}

func TestSwitchingConversationsOpensTheClickedOne(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[{"id":"c1","title":"会话一","archivedAt":null},{"id":"c2","title":"会话二","archivedAt":null}]`))
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话一"}]}`))
		case "/api/conversations/c2":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话二"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.load()
	if state.active != "c1" || len(state.ids) != 2 {
		t.Fatalf("active %q ids %v", state.active, state.ids)
	}
	state.open("c2")
	if state.active != "c2" || len(state.messages) != 1 || state.messages[0].Text != "来自会话二" {
		t.Fatalf("active %q messages %+v", state.active, state.messages)
	}
	tester := ui.NewTester(state.view, 900, 620)
	if !tester.HasText("会话一") || !tester.HasText("会话二") {
		t.Fatalf("both conversations must be offered, texts %q", tester.Texts())
	}
	if !tester.HasText("来自会话二") {
		t.Fatalf("the transcript must follow the switched conversation, texts %q", tester.Texts())
	}
}

func TestToolCallsGroupIntoOneRowPerRun(t *testing.T) {
	messages := []transcriptMessage{
		{Role: "user", Text: "跑一下"},
		{Role: "tool", State: "done", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "bash"}},
		{Role: "tool", State: "done", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "bash"}},
		{Role: "tool", State: "running", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "edit"}},
		{Role: "assistant", Kind: "chat", Text: "好了"},
	}
	runs := groupRuns(messages)
	if len(runs) != 3 {
		t.Fatalf("runs %d: %+v", len(runs), runs)
	}
	if runs[0].tools || !runs[1].tools || runs[2].tools {
		t.Fatalf("alternation broken: %+v", runs)
	}
	if len(runs[1].messages) != 3 {
		t.Fatalf("consecutive tool calls must share one run, got %d", len(runs[1].messages))
	}
	if summary := runSummary(runs[1]); summary != "bash, edit · 进行中" {
		t.Fatalf("summary %q", summary)
	}
	finished := transcriptRun{tools: true, messages: messages[1:2]}
	if summary := runSummary(finished); summary != "bash" {
		t.Fatalf("a finished run must not say 进行中: %q", summary)
	}
}

func TestToolMessagesSurviveParsingSoTheViewCanGroupThem(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
		{"role":"tool","kind":"tool","state":"done","text":"bash: ls","data":{"tool":"bash","toolCallId":"t1","ordinal":1}},
		{"role":"assistant","text":"看完了"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Role != "tool" || messages[0].Data.Tool != "bash" {
		t.Fatalf("messages %+v", messages)
	}
	if summary := runSummary(transcriptRun{tools: true, messages: messages[:1]}); summary != "bash" {
		t.Fatalf("summary %q", summary)
	}
}
