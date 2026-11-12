package graph

import "testing"

func TestTheReloadReceiptStaysOutOfTheConversation(t *testing.T) {
	receipt := map[string]any{"id": "rsi-1"}
	tools := []PiAdapterToolActivity{}
	activity := []PiAdapterActivityRecord{}
	turn := piAdapterTurnInput{Gate: &TaskSendGate{}, ReloadReceipt: &receipt, ToolActivity: &tools, Activity: &activity}
	result := piAdapterTurnOutcome(PiAdapterOptions{}, piAdapterRunInput{}, turn, ModelEntry{}, "reply that must not be shown", nil, Operation{}, "")
	output, ok := result.Output.(map[string]any)
	if !ok {
		t.Fatalf("output %+v", result.Output)
	}
	if text, ok := output["text"]; ok {
		t.Fatalf("a reload receipt must not add chat text, got %q", text)
	}
	if output["rsiRequestId"] != "rsi-1" {
		t.Fatalf("the receipt id stays for the machinery, output %+v", output)
	}
}
