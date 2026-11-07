// graph:table-writes-exempt: the test seeds the task and operation rows the handoff belongs to
package graph

import (
	"context"
	"strings"
	"testing"
	"time"
)

type autoDeferFixture struct {
	store      *TaskStore
	modes      *[]string
	dispatched *map[string]int
	closed     func()
}

func newAutoDeferFixture(t *testing.T) autoDeferFixture {
	t.Helper()
	store, closeStore := newDeferredTestStore(t)
	t.Cleanup(closeStore)
	store.DB.SetMaxOpenConns(1)
	seeds := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,root,grants) VALUES('p',?,'[]')`, []any{t.TempDir()}},
		{`INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version)
      VALUES('t','p','c','',1,0,'chatting',0,1,1)`, nil},
		{`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
      VALUES('c','p','p','t','stub',1,1)`, nil},
		{`INSERT INTO nodes(task_id,id,spec) VALUES('t','n','{"role":"master"}')`, nil},
		{`INSERT INTO instances(id,task_id,node_id) VALUES('i','t','n')`, nil},
		{`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved)
      VALUES('op','t','n','i',1,'{}','running',0)`, nil},
	}
	for _, seed := range seeds {
		if _, err := store.DB.Exec(seed.sql, seed.args...); err != nil {
			t.Fatalf("seed %s: %v", seed.sql, err)
		}
	}
	NewKernelStore(store)
	modes := []string{}
	dispatched := map[string]int{}
	return autoDeferFixture{store: store, modes: &modes, dispatched: &dispatched, closed: closeStore}
}

func (fixture autoDeferFixture) input(body func() (any, error), threshold int) autoToolAdmission {
	gate := SendGate{
		Dispatch: func(id string, _ float64, send func() any) any {
			(*fixture.dispatched)[id] += 1
			if (*fixture.dispatched)[id] > 1 {
				Raise("invalid_input", "Invocation already dispatched")
			}
			return send()
		},
		Settle: func(_ string, _ *TokenUsage) { *fixture.modes = append(*fixture.modes, "settled") },
	}
	return autoToolAdmission{
		Store: fixture.store,
		Request: AgentSessionRequest{
			ExecutionId: "op",
			Broker:      gate,
		},
		Definition: ToolDefinition{
			Name:        "bash",
			Description: "stub",
			Parameters:  map[string]any{"type": "object"},
			Execute:     func(string, any) (any, error) { return body() },
			Deferred:    func(string, any, *AbortSignal) (any, error) { return body() },
		},
		Params:      map[string]any{"command": "sleep 60"},
		Gate:        gate,
		ThresholdMs: threshold,
	}
}

func autoDeferAnswer(text string) any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}
}

func deferredRows(t *testing.T, store *TaskStore) []DeferredToolCall {
	t.Helper()
	rows := kernelRows(store.Db, "SELECT * FROM deferred_tool_calls ORDER BY started_at")
	out := []DeferredToolCall{}
	for _, row := range rows {
		if call := deferredToolCallRow(row); call != nil {
			out = append(out, *call)
		}
	}
	return out
}

func TestToolInsideTheThresholdAnswersInlineAndLeavesNoRecord(t *testing.T) {
	fixture := newAutoDeferFixture(t)
	value, err := runToolWithHandoff(fixture.input(func() (any, error) { return "quick-marker", nil }, 5_000), context.Background())
	if err != nil {
		t.Fatalf("inline call failed: %v", err)
	}
	if value != "quick-marker" {
		t.Fatalf("inline call answered %v instead of the tool result", value)
	}
	if rows := deferredRows(t, fixture.store); len(rows) != 0 {
		t.Fatalf("a tool that finished inside the threshold left %d background records", len(rows))
	}
	if calls := *fixture.modes; len(calls) != 1 {
		t.Fatalf("the inline call settled the gate %d times", len(calls))
	}
	if count := dispatchCount(fixture); count != 1 {
		t.Fatalf("the inline call dispatched %d invocations instead of one", count)
	}
}

func TestToolPastTheThresholdHandsOffAndSettlesTheSameRecord(t *testing.T) {
	fixture := newAutoDeferFixture(t)
	value, err := runToolWithHandoff(fixture.input(func() (any, error) {
		time.Sleep(400 * time.Millisecond)
		return autoDeferAnswer("late-marker"), nil
	}, 50), context.Background())
	if err != nil {
		t.Fatalf("handoff call failed: %v", err)
	}
	receipt := CanonicalJSON(value)
	if !strings.Contains(receipt, `"status":"accepted"`) {
		t.Fatalf("the tool past the threshold answered %s instead of a background receipt", receipt)
	}
	var settled DeferredToolCall
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		rows := deferredRows(t, fixture.store)
		if len(rows) == 1 && !DeferredToolCallActive(rows[0].State) {
			settled = rows[0]
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if settled.Id == "" {
		t.Fatalf("the handed-off call never settled")
	}
	if settled.State != DeferredToolSettled {
		t.Fatalf("the handed-off call settled as %s: %s", settled.State, settled.Reason)
	}
	if !strings.Contains(settled.Result, "late-marker") {
		t.Fatalf("the handed-off call recorded %q instead of the command output", settled.Result)
	}
	wake := kernelRow(fixture.store.Db, "SELECT state FROM wake_intents WHERE kind=? AND dedupe_key=? LIMIT 1",
		string(WakeKindToolSettled), "deferred:"+settled.Id)
	if wake == nil {
		t.Fatalf("the handed-off call settled without waking the conversation")
	}
	resume := kernelRows(fixture.store.Db, "SELECT id FROM messages WHERE conversation_id='c' AND json_extract(data,'$.source.kind')='tool_settled'")
	if len(resume) != 1 {
		t.Fatalf("the settled call left %d resume messages instead of one", len(resume))
	}
	if count := dispatchCount(fixture); count != 1 {
		t.Fatalf("the handed-off call dispatched %d invocations instead of one", count)
	}
}

func dispatchCount(fixture autoDeferFixture) int {
	total := 0
	for _, count := range *fixture.dispatched {
		total += count
	}
	return total
}

func TestDeferredResultSteersTheRunningTurnInsteadOfQueueingAMessage(t *testing.T) {
	fixture := newAutoDeferFixture(t)
	var delivered []string
	unregister := RegisterConversationInjector("c", func(text string) bool {
		delivered = append(delivered, text)
		return true
	})
	defer unregister()
	call := DeferredToolCall{
		Id: "deferred-1", TaskId: "t", ConversationId: "c", NodeId: "n", ToolName: "bash",
		ToolCallId: "call-1", State: DeferredToolSettled, Result: "late-marker",
	}
	resumeConversationForDeferredTool(fixture.store, call)
	if len(delivered) != 1 {
		t.Fatalf("the settled call was injected %d times into the running turn", len(delivered))
	}
	if !strings.Contains(delivered[0], "bash") {
		t.Fatalf("the injected text says nothing about the tool: %q", delivered[0])
	}
	rows := kernelRows(fixture.store.Db, "SELECT state FROM messages WHERE conversation_id='c' AND json_extract(data,'$.source.kind')='tool_settled'")
	if len(rows) != 1 {
		t.Fatalf("the transcript recorded %d rows for the settled call", len(rows))
	}
	if kernelString(rows[0]["state"]) != string(MessageStateDone) {
		t.Fatalf("the recorded row is %q, so it would be queued as a new turn", kernelString(rows[0]["state"]))
	}
	if kernelRow(fixture.store.Db, "SELECT id FROM wake_intents WHERE task_id='t'") != nil {
		t.Fatalf("a delivered result also asked for a new turn")
	}
}

func TestClosingASessionStopsInjectingIntoItsConversation(t *testing.T) {
	received := 0
	unregister := RegisterConversationInjector("c", func(string) bool {
		received += 1
		return true
	})
	if conversationInjectorOf("c") == nil {
		t.Fatalf("a registered session was not reachable by its conversation")
	}
	unregister()
	if conversationInjectorOf("c") != nil {
		t.Fatalf("a closed session kept receiving injections")
	}
	unregister()
	if received != 0 {
		t.Fatalf("registering injected %d messages by itself", received)
	}
}

func TestDeferredResultStartsATurnWhenNothingIsRunning(t *testing.T) {
	fixture := newAutoDeferFixture(t)
	call := DeferredToolCall{
		Id: "deferred-2", TaskId: "t", ConversationId: "c", NodeId: "n", ToolName: "bash",
		ToolCallId: "call-2", State: DeferredToolSettled, Result: "late-marker",
	}
	resumeConversationForDeferredTool(fixture.store, call)
	rows := kernelRows(fixture.store.Db, "SELECT state FROM messages WHERE conversation_id='c' AND json_extract(data,'$.source.kind')='tool_settled'")
	if len(rows) != 1 {
		t.Fatalf("the transcript recorded %d rows for the settled call", len(rows))
	}
	if kernelString(rows[0]["state"]) == string(MessageStateDone) {
		t.Fatalf("an idle conversation recorded the result as already delivered")
	}
}

func TestToolHandsOffOnlyWhenItsBudgetExceedsTheThreshold(t *testing.T) {
	t.Setenv(deferredToolThresholdEnv, "1000")
	tools := ToolDefinition{
		Name: "bash", Parameters: map[string]any{"type": "object"},
		Execute:  func(string, any) (any, error) { return nil, nil },
		Deferred: func(string, any, *AbortSignal) (any, error) { return nil, nil },
	}
	if !deferredToolAutoHandsOff(tools, map[string]any{"command": "sleep 60"}) {
		t.Fatalf("a command with the default budget was not eligible for handoff")
	}
	if deferredToolAutoHandsOff(tools, map[string]any{"command": "sleep 60", "timeout": 800}) {
		t.Fatalf("a command bounded below the threshold was taken away from its turn")
	}
	if deferredToolAutoHandsOff(ToolDefinition{Name: "read", Execute: func(string, any) (any, error) { return nil, nil }}, map[string]any{}) {
		t.Fatalf("a tool with no background body was treated as deferrable")
	}
	t.Setenv(deferredToolThresholdEnv, "")
	if deferredToolThresholdMs() != deferredToolThresholdDefaultMs {
		t.Fatalf("the threshold default drifted away from %dms", deferredToolThresholdDefaultMs)
	}
}
