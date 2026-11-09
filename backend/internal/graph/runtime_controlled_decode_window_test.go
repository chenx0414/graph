package graph

import "testing"

func TestTheStreamTimestampsItsOwnDecodeWindow(t *testing.T) {
	clock := int64(4_000)
	stream := &controlledStream{
		message:  &AssistantMessage{Role: "assistant"},
		finished: true,
		now:      func() int64 { return clock },
	}
	stream.handleEvent(map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"content": "First"},
	}}})
	clock = 4_900
	stream.handleEvent(map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"content": " and last"},
	}}})
	stream.message.StopReason = "stop"

	result := stream.Result()
	reported, ok := result["durationMs"]
	if !ok {
		t.Fatalf("the settled message carried no decode duration: %v", result)
	}
	if duration := kernelInt(reported); duration != 900 {
		t.Fatalf("the decode window must span the first to the last delta: got %v", reported)
	}
}

func TestAStreamWithoutDeltasReportsNoDecodeWindow(t *testing.T) {
	stream := &controlledStream{
		message:  &AssistantMessage{Role: "assistant"},
		finished: true,
		now:      func() int64 { return 7_000 },
	}
	stream.message.StopReason = "stop"

	if reported, ok := stream.Result()["durationMs"]; ok {
		t.Fatalf("a stream that produced no tokens must not claim a decode duration: %v", reported)
	}
}

func TestTheSettledUsageCarriesTheSameDecodeWindow(t *testing.T) {
	clock := int64(9_000)
	var settled *TokenUsage
	stream := &controlledStream{
		message:    &AssistantMessage{Role: "assistant"},
		finished:   true,
		invocation: "inv-1",
		now:        func() int64 { return clock },
		broker: SendGate{Settle: func(_ string, usage *TokenUsage) {
			settled = usage
		}},
	}
	stream.handleEvent(map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"content": "One"},
	}}})
	clock = 9_400
	stream.handleEvent(map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"content": " two"},
	}}})
	_ = stream.Result()

	usage := &TokenUsage{Input: 10, Output: 2, CacheRead: 320_000}
	stream.settle(usage)
	if settled == nil {
		t.Fatalf("the invocation was never settled")
	}
	if settled.DurationMs == nil || *settled.DurationMs != 400 {
		t.Fatalf("the settled usage lost the decode window: %v", settled.DurationMs)
	}
}

func TestSettledUsageWithoutTokensCarriesNoDecodeWindow(t *testing.T) {
	var settled *TokenUsage
	stream := &controlledStream{
		message:    &AssistantMessage{Role: "assistant"},
		finished:   true,
		invocation: "inv-2",
		now:        func() int64 { return 1_000 },
		broker: SendGate{Settle: func(_ string, usage *TokenUsage) {
			settled = usage
		}},
	}
	_ = stream.Result()
	stream.settle(&TokenUsage{Input: 10})
	if settled == nil || settled.DurationMs != nil {
		t.Fatalf("a request without output tokens must not claim a decode window: %v", settled)
	}
}

func TestTheSettledUsageCarriesTheFirstTokenWaitSeparately(t *testing.T) {
	clock := int64(1_000)
	var settled *TokenUsage
	stream := &controlledStream{
		message:    &AssistantMessage{Role: "assistant"},
		finished:   true,
		invocation: "inv-3",
		startedAt:  1_000,
		now:        func() int64 { return clock },
		broker: SendGate{Settle: func(_ string, usage *TokenUsage) {
			settled = usage
		}},
	}
	clock = 41_000
	stream.handleEvent(map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"content": "晚到的第一个字"},
	}}})
	clock = 41_900
	stream.handleEvent(map[string]any{"choices": []any{map[string]any{
		"delta": map[string]any{"content": "，然后是第二个"},
	}}})
	_ = stream.Result()
	stream.settle(&TokenUsage{Input: 10, Output: 2})

	if settled == nil {
		t.Fatalf("the invocation was never settled")
	}
	if settled.FirstTokenMs == nil || *settled.FirstTokenMs != 40_000 {
		t.Fatalf("the wait before the first token must be recorded on its own: %v", settled.FirstTokenMs)
	}
	if settled.DurationMs == nil || *settled.DurationMs != 900 {
		t.Fatalf("the decode window must stay the time between deltas: %v", settled.DurationMs)
	}
}
