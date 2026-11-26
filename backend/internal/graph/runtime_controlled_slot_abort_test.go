package graph

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A turn waiting for an execution slot can be abandoned: the operation was
// interrupted, its task closed, or its lane cancelled. That is a normal way for
// a request to end, and the daemon writes it as an error on the turn.
//
// It used to end the process instead. `ControlledGatedProviderFetch` acquired
// the slot outside the recover scope that turns a panic into a failed request,
// and the slot reports "aborted" by panicking, so the panic walked out of the
// provider fetch and killed the daemon (daemon.log: "panic: Execution slot wait
// aborted [recovered, repanicked]", twice).
func TestASlotAbortDoesNotTakeTheDaemonDown(t *testing.T) {
	asked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = true
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"unreachable\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	entry := ModelEntry{
		Id: "m", Provider: "p", Api: "openai-completions",
		BaseUrl: server.URL + "/v1", ContextWindow: 8000, MaxTokens: 256,
	}
	gate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any { return send() },
		Settle:   func(id string, usage *TokenUsage) {},
	}
	abandoned := executionSlotsAborted()
	stream := ControlledOpenAIStream(gate, entry,
		func(ModelEntry) string { return "key" },
		func(ModelEntry) *piAdapterSlot {
			return &piAdapterSlot{acquire: func(*AbortSignal) (func(), error) { return nil, abandoned }}
		},
		"openai-completions", PiAdapterStreamOptions{})
	opened, err := stream(map[string]any{"id": "m", "api": "openai-completions", "provider": "p", "baseUrl": entry.BaseUrl},
		map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}}, nil)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	// Next must return, not panic: this is the line that used to kill the daemon.
	message := rejectionMessage(opened)
	if !strings.Contains(message, "Execution slot wait aborted") {
		t.Fatalf("an abandoned slot wait ends the turn with its own reason, got %q", message)
	}
	if asked {
		t.Fatal("a turn whose slot wait was abandoned must not reach the provider")
	}
}

// The same abandonment inside the send gate: acquiring the slot panics rather
// than returning an error, which is what the kernel lane does. The boundary has
// to hold for both shapes.
func TestASlotAbortThatPanicsIsStillOnlyATurnFailure(t *testing.T) {
	entry := ModelEntry{Id: "m", Provider: "p", Api: "openai-completions",
		BaseUrl: "http://127.0.0.1:1/v1", ContextWindow: 8000, MaxTokens: 256}
	gate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any { return send() },
		Settle:   func(id string, usage *TokenUsage) {},
	}
	abandoned := executionSlotsAborted()
	stream := ControlledOpenAIStream(gate, entry,
		func(ModelEntry) string { return "key" },
		func(ModelEntry) *piAdapterSlot {
			return &piAdapterSlot{acquire: func(*AbortSignal) (func(), error) { panic(abandoned) }}
		},
		"openai-completions", PiAdapterStreamOptions{})
	opened, err := stream(map[string]any{"id": "m", "api": "openai-completions", "provider": "p", "baseUrl": entry.BaseUrl},
		map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}}, nil)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if message := rejectionMessage(opened); !strings.Contains(message, "Execution slot wait aborted") {
		t.Fatalf("a panicking slot abort is reported as the turn's failure, got %q", message)
	}
}
