package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const transcriptStringErrorPayload = `{"messages":[
 {"id":"m1","seq":1,"role":"user","kind":"chat","text":"跑一下","state":"delivered"},
 {"id":"m2","seq":2,"role":"assistant","kind":"chat","text":"跑完了","state":"done"},
 {"id":"m3","seq":3,"role":"tool","kind":"tool","text":"bash: rsi","state":"failed","data":{"tool":"bash","error":"RSI replacement ... found 2"}},
 {"id":"m4","seq":4,"role":"system","kind":"rsi","text":"RSI 替换失败","state":"done","data":{"error":"RSI replacement ... found 2"}}
]}`

func TestTranscriptDataAcceptsAStringError(t *testing.T) {
	messages, err := parseConversationRaw([]byte(transcriptStringErrorPayload))
	if err != nil {
		t.Fatalf("a string error must not break the transcript: %v", err)
	}
	if len(messages) != 4 {
		t.Fatalf("every message parses, got %d", len(messages))
	}
	tool := messages[2]
	if !tool.Data.Error {
		t.Fatalf("a nonempty string error reads as an error, got %+v", tool.Data)
	}
	if !strings.Contains(tool.Data.ErrorText, "RSI replacement") {
		t.Fatalf("the string error keeps its text, got %q", tool.Data.ErrorText)
	}
}

func TestTranscriptDataKeepsTheBooleanError(t *testing.T) {
	messages, err := parseConversationRaw([]byte(`{"messages":[{"id":"m1","role":"tool","text":"bash","data":{"error":true}}]}`))
	if err != nil {
		t.Fatalf("a boolean error still parses: %v", err)
	}
	if !messages[0].Data.Error || messages[0].Data.ErrorText != "" {
		t.Fatalf("a boolean error reads as one without text, got %+v", messages[0].Data)
	}
	var body transcriptMessageData
	if err := json.Unmarshal([]byte(`{"error":false}`), &body); err != nil || body.Error {
		t.Fatalf("a false error reads as no error, got %+v (%v)", body, err)
	}
	if err := json.Unmarshal([]byte(`{"error":""}`), &body); err != nil || body.Error {
		t.Fatalf("an empty string error reads as no error, got %+v (%v)", body, err)
	}
}

func TestAToolPanelShowsTheStringErrorText(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
	 {"id":"m1","seq":1,"role":"user","kind":"chat","text":"跑一下","state":"delivered"},
	 {"id":"m2","seq":2,"role":"tool","kind":"tool","text":"bash: rsi","state":"failed","data":{"tool":"bash","command":"rsi","error":"RSI replacement ... found 2"}}
	]}`))
	if err != nil {
		t.Fatalf("the transcript parses: %v", err)
	}
	state := &chatState{expanded: map[string]bool{}}
	tester := newTester(func(ctx *ui.Context) {
		gwtheme.Apply(ctx, gwtheme.Light())
		state.messages = messages
		state.view(ctx)
	}, 900, 700)
	for frame := 0; frame < 3; frame++ {
		render(tester)
	}
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("open the tool run: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("已运行 rsi"); err != nil {
		t.Fatalf("open the tool panel: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("RSI replacement") {
		t.Fatalf("the panel shows the failure text, texts %q", tester.Texts())
	}
}

func TestLoadOlderTakesAHistoryPageWithStringErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/conversations/c1/history") {
			_, _ = w.Write([]byte(transcriptStringErrorPayload))
			return
		}
		_, _ = w.Write([]byte(`{"messages":[{"id":"m9","seq":9,"role":"user","text":"最新的"}]}`))
	}))
	t.Cleanup(server.Close)
	state := newChatState(server.URL, "tok")
	state.open("c1")
	state.status = ""
	older, _, _, err := state.source.LoadOlder(state, 9)
	if err != nil {
		t.Fatalf("an older page with a string error loads: %v", err)
	}
	if len(older) != 3 {
		t.Fatalf("the older page keeps its spoken messages, got %d", len(older))
	}
	if strings.Contains(state.status, "预期的 JSON") {
		t.Fatalf("the chat reports no JSON complaint, status %q", state.status)
	}
}

func TestAnEmptyReplyNoticeReachesTheTranscript(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
	 {"id":"m1","seq":1,"role":"user","kind":"chat","text":"做这条","state":"delivered"},
	 {"id":"m2","seq":2,"role":"system","kind":"notice","text":"本轮模型没有返回任何内容。","state":"done","data":{"source":{"form":"notice","summary":"本轮没有回复"}}}
	]}`))
	if err != nil {
		t.Fatalf("the transcript parses: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("the notice must reach the transcript, messages %+v", messages)
	}
	if messages[1].Text != "本轮模型没有返回任何内容。" {
		t.Fatalf("the notice text must survive, got %+v", messages[1])
	}
}
