package graph

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A provider that answers without a usage report leaves two legitimate
// outcomes, and the choice belongs to the caller: report the call as unknown,
// or estimate it from the request. Getting this backwards either invents
// numbers for a priced call or makes a real send look unaccountable, so the
// decision is asserted at the provider boundary with a real HTTP answer.
func TestMissingProviderUsageIsEstimatedOnlyWhenTheCallerAsks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		frame := func(payload string) { _, _ = w.Write([]byte("data: " + payload + "\n\n")) }
		frame(`{"id":"r","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}`)
		frame(`{"id":"r","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	entry := ModelEntry{
		Id: "m", Provider: "p", Grade: "high", Api: "openai-completions",
		BaseUrl: server.URL + "/v1", ContextWindow: 8000, MaxTokens: 256,
	}
	request := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello there"}}}

	settle := func(estimate bool) *TokenUsage {
		var settled *TokenUsage
		gate := SendGate{
			Dispatch: func(id string, reservation float64, send func() any) any { return send() },
			Settle:   func(id string, usage *TokenUsage) { settled = usage },
		}
		stream := ControlledOpenAIStream(gate, entry,
			func(ModelEntry) string { return "key" },
			func(ModelEntry) *piAdapterSlot { return nil },
			"openai-completions", PiAdapterStreamOptions{EstimateMissing: estimate})
		opened, err := stream(map[string]any{"id": "m", "api": "openai-completions", "provider": "p", "baseUrl": entry.BaseUrl}, request, nil)
		if err != nil {
			t.Fatalf("open stream: %v", err)
		}
		for {
			if _, ok := opened.Next(); !ok {
				break
			}
		}
		if settled == nil {
			t.Fatalf("the send never settled its usage (estimate=%v) result=%v", estimate, opened.Result())
		}
		return settled
	}

	honest := settle(false)
	if honest.UsageSource == nil || *honest.UsageSource != string(UsageUnknown) {
		t.Fatalf("without estimation the call must settle as unknown, got %+v", honest)
	}

	estimated := settle(true)
	if estimated.UsageSource != nil && *estimated.UsageSource == string(UsageUnknown) {
		t.Fatalf("with estimation the call must carry numbers, got %+v", estimated)
	}
	if TokenUsageTotal(*estimated) <= 0 {
		t.Fatalf("an estimate has to be positive, got %+v", estimated)
	}
}
