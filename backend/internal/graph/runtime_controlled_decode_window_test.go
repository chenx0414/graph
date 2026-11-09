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
