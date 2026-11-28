package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// /new writes no message, so it must re-read the card by itself.
func TestOpeningANewContextRefreshesTheContextCardWithoutAPrompt(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/conversations/c1/new-context":
			w.Write([]byte(`{"conversationId":"c1","reset":1}`))
		case r.URL.Path == "/api/conversations/c1/trajectory":
			empty := reads.Add(1) > 1
			used := 90000
			if empty {
				used = 0
			}
			w.Write([]byte(`{"conversationId":"c1","taskId":"t1",` +
				`"composition":{"systemPrompt":4000,"toolDefinitions":8000,"userMessages":500,"assistantReply":40000,"toolCalls":6000,"injected":1500},` +
				`"totals":{"context":{"lastTokens":` + itoa(used) + `,"peakTokens":90000}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	shell := newShellState(server.URL, "tok")
	shell.selectConversation("c1")
	if chat := shell.active(); chat != nil {
		chat.currentModel = "deepseek-v4"
	}
	shell.modelMeta = map[string]modelMeta{"deepseek-v4": {id: "deepseek-v4", modelID: "deepseek-v4", contextWindow: 1_000_000}}
	shell.trajectory.scopeKey = shell.chatScope().key()
	shell.trajectory.data = &conversationTrajectory{
		ConversationId: "c1", TaskId: "t1",
		Totals: trajectoryTotals{Context: trajectoryContext{LastTokens: 90_000, PeakTokens: 90_000}},
	}
	first := reads.Load()

	shell.active().newAgentContext()

	deadline := time.Now().Add(3 * time.Second)
	for reads.Load() == first && time.Now().Before(deadline) {
		waitForUI()
		time.Sleep(time.Millisecond)
	}
	if reads.Load() == first {
		t.Fatal("opening a new context never re-read the context card")
	}
}
