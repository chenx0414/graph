// graph:table-writes-exempt: the test seeds the rows an admission reads
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func turnFor(activity []PiAdapterActivityRecord, tools []PiAdapterToolActivity, active map[string]bool) piAdapterTurnInput {
	return piAdapterTurnInput{
		Gate: &TaskSendGate{}, ToolActivity: &tools, Activity: &activity,
		ActiveConversationTools: active, SawAssistantMessageEnd: new(bool), Compacting: new(bool), GateRefusal: new(error),
	}
}

func TestAnEmptyReplyWithUnfinishedToolCallsKeepsTheTurnOpen(t *testing.T) {
	active := map[string]bool{"call-1": true, "call-2": true}
	turn := turnFor(nil, nil, active)
	result := piAdapterTurnOutcome(PiAdapterOptions{}, piAdapterRunInput{}, turn, ModelEntry{}, "", nil, Operation{}, "")
	if result.Outcome == "completed" {
		t.Fatalf("a turn whose tool calls never finished must not settle as complete: %+v", result.Output)
	}
	if result.Output.(map[string]any)["retryCode"] != "tool_calls_unfinished" {
		t.Fatalf("the turn must say why it stayed open, output %+v", result.Output)
	}
}

func TestAnEmptyReplyWithFinishedToolCallsContinuesOnce(t *testing.T) {
	active := map[string]bool{}
	tools := []PiAdapterToolActivity{{ToolCallId: "call-1", Name: "bash", State: "done"}}
	turn := turnFor(nil, tools, active)
	result := piAdapterTurnOutcome(PiAdapterOptions{}, piAdapterRunInput{}, turn, ModelEntry{}, "", nil, Operation{}, "")
	if result.Outcome != "continue" {
		t.Fatalf("a turn whose tools ran but whose model stopped without text must continue once, got %q", result.Outcome)
	}
	if result.Output.(map[string]any)["retryCode"] != "tool_calls_unfinished" {
		t.Fatalf("the turn must say why it stayed open, output %+v", result.Output)
	}
}

func TestAnEmptyReplyAfterFinishedToolCallsStopsOnTheSecondTurn(t *testing.T) {
	tools := []PiAdapterToolActivity{{ToolCallId: "call-1", Name: "bash", State: "done"}}
	turn := turnFor(nil, tools, map[string]bool{})
	operation := Operation{Id: "op1", TaskId: "t1", NodeId: "master", Kind: "agent", Attempt: 2,
		Context: OperationContext{PreviousOutput: map[string]any{"retryCode": "tool_calls_unfinished", "text": ""}}}
	result := piAdapterTurnOutcome(PiAdapterOptions{}, piAdapterRunInput{}, turn, ModelEntry{}, "", nil, operation, "")
	if result.Outcome != "failed" {
		t.Fatalf("a second empty turn after its tools ran must stop and report, got %q", result.Outcome)
	}
	if message, _ := result.Output.(map[string]any)["error"].(string); strings.TrimSpace(message) == "" {
		t.Fatalf("the stop must say what happened, output %+v", result.Output)
	}
}

func TestAnEmptyReplyWithNoWorkAtAllSaysSoInsteadOfCompletingSilently(t *testing.T) {
	turn := turnFor(nil, nil, map[string]bool{})
	result := piAdapterTurnOutcome(PiAdapterOptions{}, piAdapterRunInput{}, turn, ModelEntry{}, "", nil, Operation{}, "")
	if result.Outcome != "completed" {
		t.Fatalf("a plain empty answer is still a completed turn, got %q", result.Outcome)
	}
	output := result.Output.(map[string]any)
	if output["emptyReply"] != true {
		t.Fatalf("an empty answer must be marked so the console can say what happened: %+v", output)
	}
}

func TestAnEmptyAnswerLeavesAVisibleNoticeInsteadOfADeadConversation(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "empty-reply.sqlite"))
	t.Cleanup(store.Close)
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/empty-reply','[]')`,
		`INSERT INTO tasks(id,project_id,conversation_id,request,created_seq,phase) VALUES('t1','p1','c1','goal',1,'chatting')`,
		`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1','p1','t1','Main',1,0,'global')`,
		`INSERT INTO nodes(task_id,id,spec,status) VALUES('t1','master','{"role":"master"}','running')`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	operation := Operation{Id: "op1", TaskId: "t1", NodeId: "master", Kind: "agent", Attempt: 1}
	RecordConversationOutput(store, operation, OperationResult{Outcome: "completed", Output: map[string]any{"text": "", "emptyReply": true}})

	rows := kernelRows(store.Db, "SELECT role,kind,text FROM messages WHERE conversation_id='c1' AND kind='notice'")
	if len(rows) != 1 {
		t.Fatalf("an empty answer must leave one visible notice, messages %+v", rows)
	}
	if strings.TrimSpace(kernelString(rows[0]["text"])) == "" {
		t.Fatalf("the notice must say what happened, got %+v", rows[0])
	}
}

func TestAFinishedTurnWritesNoEmptyStatement(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "empty-reply.sqlite"))
	t.Cleanup(store.Close)
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/empty-reply','[]')`,
		`INSERT INTO tasks(id,project_id,conversation_id,request,created_seq,phase) VALUES('t1','p1','c1','goal',1,'chatting')`,
		`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1','p1','t1','Main',1,0,'global')`,
		`INSERT INTO nodes(task_id,id,spec,status) VALUES('t1','master','{"role":"master"}','running')`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	operation := Operation{Id: "op2", TaskId: "t1", NodeId: "master", Kind: "agent", Attempt: 1}
	RecordConversationOutput(store, operation, OperationResult{Outcome: "completed", Output: map[string]any{"text": "done"}})
	if rows := kernelRows(store.Db, "SELECT id FROM messages WHERE conversation_id='c1' AND kind='notice'"); len(rows) != 0 {
		t.Fatalf("a normal answer needs no notice, got %+v", rows)
	}
}

func TestASecondUnfinishedTurnStopsInsteadOfLoopingForever(t *testing.T) {
	active := map[string]bool{"call-1": true}
	turn := turnFor(nil, nil, active)
	previous := map[string]any{"retryCode": "tool_calls_unfinished", "text": ""}
	operation := Operation{Id: "op1", TaskId: "t1", NodeId: "master", Kind: "agent", Attempt: 2, Context: OperationContext{PreviousOutput: previous}}
	result := piAdapterTurnOutcome(PiAdapterOptions{}, piAdapterRunInput{}, turn, ModelEntry{}, "", nil, operation, "")
	if result.Outcome != "failed" {
		t.Fatalf("a second unfinished turn must stop and report, got %q", result.Outcome)
	}
	if message, _ := result.Output.(map[string]any)["error"].(string); strings.TrimSpace(message) == "" {
		t.Fatalf("the stop must say what happened, output %+v", result.Output)
	}
}
