package graph

import (
	"encoding/json"
	"testing"
)

func TestToolActivityCarriesItsArgumentsForTheChatPanel(t *testing.T) {
	records := ConversationActivityRecords([]any{map[string]any{
		"type": "tool", "name": "graph_inspect", "summary": "graph_inspect",
		"args": map[string]any{"query": "SELECT 1"}, "output": "ok", "ordinal": 1,
	}}, "")
	if len(records) != 1 {
		t.Fatalf("records %+v", records)
	}
	args, _ := records[0].Data["args"].(string)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(args), &decoded); err != nil || decoded["query"] != "SELECT 1" {
		t.Fatalf("the arguments ride the activity as JSON, got %v (%v)", records[0].Data["args"], err)
	}
}
