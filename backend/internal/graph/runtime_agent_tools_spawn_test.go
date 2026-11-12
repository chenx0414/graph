package graph

import (
	"strings"
	"testing"
)

func TestAgentToolsOfferSpawnAgentWhenTheHostCanSpawn(t *testing.T) {
	called := AgentToolsSpawnInput{}
	tools := AgentTools(AgentToolsInput{
		Workspace: t.TempDir(), Role: "worker",
		Spawn: func(input AgentToolsSpawnInput) any {
			called = input
			return map[string]any{"agentId": "child-1", "conversationId": "child-1", "taskId": "task-1"}
		},
	})
	found := false
	for _, tool := range tools {
		if tool.Name != "spawn_agent" {
			continue
		}
		found = true
		result, err := tool.Execute("call-1", map[string]any{"objective": "研究 MyGo 的 Draw API", "name": "研究员"})
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		if !strings.Contains(stringifyJSON(result), "child-1") {
			t.Fatalf("receipt = %v", result)
		}
	}
	if !found {
		t.Fatal("a spawn-capable Agent must be offered spawn_agent")
	}
	if called.Objective != "研究 MyGo 的 Draw API" || called.Name != "研究员" {
		t.Fatalf("spawn input = %+v", called)
	}
}

func TestAgentToolsHideSpawnAgentWithoutAHost(t *testing.T) {
	for _, tool := range AgentTools(AgentToolsInput{Workspace: t.TempDir(), Role: "worker"}) {
		if tool.Name == "spawn_agent" {
			t.Fatal("an Agent without a spawn host must not see spawn_agent")
		}
	}
}
