package graph

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func rejectionStream(t *testing.T, status int, body string) ModelEventStream {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	entry := ModelEntry{
		Id: "m", Provider: "p", Api: "openai-completions",
		BaseUrl: server.URL + "/v1", ContextWindow: 8000, MaxTokens: 256,
	}
	gate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any { return send() },
		Settle:   func(id string, usage *TokenUsage) {},
	}
	stream := ControlledOpenAIStream(gate, entry,
		func(ModelEntry) string { return "key" },
		func(ModelEntry) *piAdapterSlot { return nil },
		"openai-completions", PiAdapterStreamOptions{})
	opened, err := stream(map[string]any{"id": "m", "api": "openai-completions", "provider": "p", "baseUrl": entry.BaseUrl},
		map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}}, nil)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	return opened
}

func rejectionMessage(opened ModelEventStream) string {
	for {
		event, ok := opened.Next()
		if !ok {
			return ""
		}
		if kind, _ := event["type"].(string); kind != "error" {
			continue
		}
		payload, _ := event["error"].(map[string]any)
		message, _ := payload["errorMessage"].(string)
		return message
	}
}

func TestAProviderRejectionCarriesTheResponseBody(t *testing.T) {
	opened := rejectionStream(t, http.StatusBadRequest, `{"error":{"message":"tools[0].name is not allowed"}}`)
	message := rejectionMessage(opened)
	if !strings.Contains(message, "HTTP 400") {
		t.Fatalf("the rejection has to keep its status, got %q", message)
	}
	if !strings.Contains(message, "tools[0].name is not allowed") {
		t.Fatalf("a 400 is a statement about the request, so its body has to survive into the error, got %q", message)
	}
}

func TestAProviderRejectionWithoutABodyStaysShort(t *testing.T) {
	opened := rejectionStream(t, http.StatusBadRequest, "")
	if message := rejectionMessage(opened); message != "Provider answered HTTP 400" {
		t.Fatalf("an empty body must not add punctuation to the message, got %q", message)
	}
}
