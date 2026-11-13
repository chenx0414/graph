package graph

import "testing"

func TestToolActivityCarriesItsOutputForTheChatPanel(t *testing.T) {
	records := ConversationActivityRecords([]any{map[string]any{
		"type": "tool", "name": "bash", "toolCallId": "call-1", "summary": "ls", "output": "file.txt\nother.txt", "ordinal": 1,
	}}, "")
	if len(records) != 1 {
		t.Fatalf("records %+v", records)
	}
	if got := records[0].Data["output"]; got != "file.txt\nother.txt" {
		t.Fatalf("the record keeps the tool output, data %+v", records[0].Data)
	}
}

func TestToolActivityOutputIsBounded(t *testing.T) {
	long := ""
	for index := 0; index < 20_000; index++ {
		long += "x"
	}
	records := ConversationActivityRecords([]any{map[string]any{
		"type": "tool", "name": "bash", "summary": "ls", "output": long, "ordinal": 1,
	}}, "")
	if len(records) != 1 {
		t.Fatalf("records %+v", records)
	}
	output, _ := records[0].Data["output"].(string)
	if len([]rune(output)) > 8_000 {
		t.Fatalf("the output is bounded, got %d runes", len([]rune(output)))
	}
}
