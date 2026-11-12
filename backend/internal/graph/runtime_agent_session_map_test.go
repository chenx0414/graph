package graph

import (
	"testing"

	"github.com/chenx0414/graph/backend/internal/agentcore"
	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func TestAgentTurnFromPigMapsTextStopReasonErrorAndUsage(t *testing.T) {
	stop := "length"
	message := "cut"
	turn := agentTurnFromPig(pigkernel.SessionTurn{
		Text:         "answer",
		StopReason:   stop,
		ErrorMessage: message,
		Usage:        &pigkernel.Usage{Input: 3, Output: 5, CacheRead: 7, CacheWrite: 11, Total: 26},
	}, AgentSessionInspect{SessionId: "s1"})
	if turn.FinalAssistantText != "answer" {
		t.Fatalf("text = %q", turn.FinalAssistantText)
	}
	if turn.StopReason == nil || *turn.StopReason != "length" {
		t.Fatalf("stop reason = %v", turn.StopReason)
	}
	if turn.ErrorMessage == nil || *turn.ErrorMessage != "cut" {
		t.Fatalf("error = %v", turn.ErrorMessage)
	}
	if turn.Usage == nil || turn.Usage.Total != 26 || turn.Usage.CacheRead != 7 || turn.Usage.CacheWrite != 11 {
		t.Fatalf("usage = %+v", turn.Usage)
	}
	if turn.Inspect.SessionId != "s1" {
		t.Fatalf("inspect = %+v", turn.Inspect)
	}
}

func TestAgentInspectFromPigKeepsToolAndMessageFields(t *testing.T) {
	inspect := agentInspectFromPig(pigkernel.SessionInspect{
		SessionId:        "s1",
		SessionFile:      "/tmp/s1.jsonl",
		ActiveTools:      []string{"read"},
		RegisteredTools:  []string{"read", "bash"},
		LoadedExtensions: []string{"graph-tools"},
		Messages:         []any{"hello"},
	})
	if inspect.SessionId != "s1" || inspect.SessionFile != "/tmp/s1.jsonl" {
		t.Fatalf("inspect = %+v", inspect)
	}
	if len(inspect.RegisteredTools) != 2 || len(inspect.ActiveTools) != 1 {
		t.Fatalf("tools = %+v", inspect)
	}
	if len(inspect.Messages) != 1 {
		t.Fatalf("messages = %+v", inspect.Messages)
	}
}

func TestAgentIdentityOfOperationFollowsTheConversation(t *testing.T) {
	operation := Operation{Id: "op", TaskId: "task", NodeId: "master"}
	identity := agentIdentityOfOperation(operation, &ConversationRow{Id: "c1", Title: "13-Graph", Role: ConversationProject})
	if identity.ID != "c1" || identity.Kind != agentcore.Project || identity.Role != "project" || identity.Name != "13-Graph" {
		t.Fatalf("project identity = %+v", identity)
	}
	global := agentIdentityOfOperation(operation, &ConversationRow{Id: "g1", Title: "Main", Role: ConversationGlobal})
	if global.Kind != agentcore.Global || global.Role != "global" || global.ID != "g1" {
		t.Fatalf("global identity = %+v", global)
	}
	orphan := agentIdentityOfOperation(operation, nil)
	if orphan.ID != "task" || orphan.Kind != agentcore.Node || orphan.Role != "master" {
		t.Fatalf("orphan identity = %+v", orphan)
	}
}

func TestAgentIdentityOfNodeDefaultsToWorker(t *testing.T) {
	identity := agentIdentityOfNode("g1", "laneA", "", "p1")
	if identity.ID != "g1/laneA" || identity.ParentID != "p1" || identity.Kind != agentcore.Node || identity.Role != "worker" || identity.Name != "laneA" {
		t.Fatalf("node identity = %+v", identity)
	}
	reviewer := agentIdentityOfNode("g1", "laneB", "reviewer", "p1")
	if reviewer.Role != "reviewer" {
		t.Fatalf("reviewer identity = %+v", reviewer)
	}
}
