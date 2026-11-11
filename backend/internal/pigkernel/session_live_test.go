package pigkernel

import (
	"strings"
	"testing"

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
