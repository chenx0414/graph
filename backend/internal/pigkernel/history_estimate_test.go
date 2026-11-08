package pigkernel

import (
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
)

func assistantTurn(usage int, stop ai.StopReason) ai.Message {
	return ai.AssistantMessage{Content: []ai.AssistantContentBlock{ai.TextContent{Text: "answer"}}, Usage: ai.Usage{TotalTokens: usage}, StopReason: stop}
}

func TestEstimateContextTokensIgnoresAbortedTurnsAsAnchors(t *testing.T) {
	messages := []ai.Message{
		assistantTurn(100000, "aborted"),
		ai.UserMessage{Content: ai.UserText("hello")},
	}
	if got := estimateContextTokens(messages); got >= 50000 {
		t.Fatalf("an aborted turn's usage must not become the anchor: got %d", got)
	}
}

func TestEstimateContextTokensAnchorsOnTheLastRealUsage(t *testing.T) {
	messages := []ai.Message{
		assistantTurn(5000, "stop"),
		ai.UserMessage{Content: ai.UserText("hello")},
	}
	got := estimateContextTokens(messages)
	if got < 5000 || got > 5010 {
		t.Fatalf("a completed turn's usage is the anchor: got %d, want about 5000", got)
	}
}
