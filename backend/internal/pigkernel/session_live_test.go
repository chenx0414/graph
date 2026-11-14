package pigkernel

import (
	"strings"
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)

func typesOf(reports []map[string]any) string {
	names := make([]string, 0, len(reports))
	for _, report := range reports {
		names = append(names, report["type"].(string))
	}
	return strings.Join(names, ",")
}

func busyState(turns int, slots ...harness.ToolSlot) *harness.LiveState {
	return &harness.LiveState{Run: &harness.LiveRun{Turns: turns}, Tools: slots}
}

func TestDiffLiveFollowsTheRunAndItsToolSlots(t *testing.T) {
	idle := liveShapeOf(nil)
	running := liveShapeOf(busyState(0, harness.ToolSlot{CallId: "call-1", Name: "read", Status: harness.ToolSlotRunning}))
	if got := typesOf(diffLive(idle, running)); got != "agent_start,tool_execution_start" {
		t.Fatalf("events = %q", got)
	}
	output := "file body"
	done := liveShapeOf(busyState(1, harness.ToolSlot{CallId: "call-1", Name: "read", Status: harness.ToolSlotDone, Output: &output}))
	reports := diffLive(running, done)
	if got := typesOf(reports); got != "turn_start,tool_execution_end" {
		t.Fatalf("events = %q", got)
	}
	content, ok := reports[1]["result"].(map[string]any)["content"].([]any)
	if !ok || len(content) != 1 || content[0].(map[string]any)["text"] != "file body" {
		t.Fatalf("tool result = %v", reports[1]["result"])
	}
	if got := typesOf(diffLive(done, liveShapeOf(nil))); got != "agent_end" {
		t.Fatalf("events = %q", got)
	}
	if got := typesOf(diffLive(running, running)); got != "" {
		t.Fatalf("an unchanged state reported %q", got)
	}
}

func TestDiffLiveKeepsCompactionsOnTheirOwnList(t *testing.T) {
	empty := liveShapeOf(nil)
	compacting := liveShapeOf(&harness.LiveState{Compactions: []harness.CompactionStatus{{TaskId: durable.TaskId(7), Trigger: durable.CompactionThreshold}}})
	started := startedCompactions(empty, compacting)
	if len(started) != 1 || started[0] != "threshold" {
		t.Fatalf("started = %v", started)
	}
	finished := finishedCompactions(compacting, empty)
	if len(finished) != 1 || finished[0] != "threshold" {
		t.Fatalf("finished = %v", finished)
	}
	if len(startedCompactions(compacting, compacting)) != 0 || len(finishedCompactions(empty, compacting)) != 0 {
		t.Fatal("a steady compaction must not report a boundary")
	}
}

func TestLiveShapeCarriesSlotOutputAndCompactionKey(t *testing.T) {
	output := "streamed"
	shape := liveShapeOf(&harness.LiveState{
		Run:         &harness.LiveRun{Turns: 2},
		Tools:       []harness.ToolSlot{{CallId: "call-9", Status: harness.ToolSlotRunning, Output: &output}},
		Compactions: []harness.CompactionStatus{{TaskId: durable.TaskId(11), Trigger: durable.CompactionOverflow}},
	})
	if !shape.busy || shape.turns != 2 || shape.tools["call-9"] != "running" || shape.outputs["call-9"] != "streamed" {
		t.Fatalf("shape = %+v", shape)
	}
	if shape.compactions["11"] != "overflow" {
		t.Fatalf("compactions = %v", shape.compactions)
	}
}

func TestDiffLiveReportsToolNamesAndArguments(t *testing.T) {
	state := &harness.LiveState{
		Run:   &harness.LiveRun{Turns: 1},
		Tools: []harness.ToolSlot{{CallId: "call-1", Name: "bash", Status: harness.ToolSlotRunning}},
		Generation: &harness.LiveGeneration{Message: &ai.AssistantMessage{Content: []ai.AssistantContentBlock{
			ai.ToolCall{ID: "call-1", Name: "bash", Arguments: ai.JsonObject{"command": "echo hi"}},
		}}},
	}
	reports := diffLive(liveShape{}, liveShapeOf(state))
	start := reports[len(reports)-1]
	if start["type"] != "tool_execution_start" || start["toolName"] != "bash" {
		t.Fatalf("the start report names its tool, got %v", start)
	}
	args, _ := start["args"].(ai.JsonObject)
	if args["command"] != "echo hi" {
		t.Fatalf("the start report carries the call arguments, got %v", start["args"])
	}
	output := "hi"
	done := liveShapeOf(&harness.LiveState{
		Run:   &harness.LiveRun{Turns: 2},
		Tools: []harness.ToolSlot{{CallId: "call-1", Name: "bash", Status: harness.ToolSlotDone, Output: &output}},
	})
	ended := diffLive(liveShapeOf(state), done)
	last := ended[len(ended)-1]
	if last["type"] != "tool_execution_end" || last["toolName"] != "bash" {
		t.Fatalf("the end report names its tool, got %v", last)
	}
}

func TestEntryToolReportsCarryNameArgumentsAndResult(t *testing.T) {
	assistant := ai.AssistantMessage{Content: []ai.AssistantContentBlock{
		ai.TextContent{Text: "跑一下"},
		ai.ToolCall{ID: "call-1", Name: "bash", Arguments: ai.JsonObject{"command": "echo hi"}},
	}}
	reports := entryToolReports([]ai.Message{assistant})
	if len(reports) != 1 || reports[0]["type"] != "tool_execution_start" || reports[0]["toolName"] != "bash" {
		t.Fatalf("the assistant entry reports its tool call, got %v", reports)
	}
	args, _ := reports[0]["args"].(ai.JsonObject)
	if args["command"] != "echo hi" {
		t.Fatalf("the call reports its arguments, got %v", reports[0]["args"])
	}
	result := ai.ToolResultMessage{
		ToolCallID: "call-1", ToolName: "bash",
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: "hi"}},
	}
	reports = entryToolReports([]ai.Message{result})
	if len(reports) != 1 || reports[0]["type"] != "tool_execution_end" || reports[0]["toolCallId"] != "call-1" {
		t.Fatalf("the result entry reports its completion, got %v", reports)
	}
	content, _ := reports[0]["result"].(map[string]any)["content"].([]any)
	if len(content) != 1 || content[0].(map[string]any)["text"] != "hi" {
		t.Fatalf("the completion carries the return value, got %v", reports[0]["result"])
	}
}
