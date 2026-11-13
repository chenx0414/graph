package graph

import (
	"encoding/json"
	"strings"
	"testing"
)

func agentControlFixture(t *testing.T) (*TaskRuntime, AgentSpawnParent, []AgentRecord) {
	t.Helper()
	runtime := spawnRuntime(t, nil)
	workspace := t.TempDir()
	runtime.projects = []ProjectConfig{{Id: "p1", Root: workspace}}
	parent := AgentSpawnParent{AgentId: "global", ProjectId: "p1", Workspace: workspace}
	RegisterAgent(runtime.store, AgentRegistration{Id: "global", Kind: "global", Workspace: workspace})
	children := []AgentRecord{}
	for _, objective := range []string{"first assignment", "second assignment", "third assignment"} {
		receipt := runtime.SpawnAgent(parent, AgentSpawnInput{Objective: objective}).(map[string]any)
		children = append(children, *AgentById(runtime.store, kernelString(receipt["agentId"])))
	}
	return runtime, parent, children
}

func callAgentControlTool(t *testing.T, runtime *TaskRuntime, parent AgentSpawnParent, action string, input map[string]any) (map[string]any, error) {
	t.Helper()
	tools := AgentTools(AgentToolsInput{Workspace: parent.Workspace, Role: "worker", ControlAgent: func(input AgentControlInput) any {
		return runtime.ControlAgent(parent, input)
	}})
	for _, tool := range tools {
		if tool.Name != action {
			continue
		}
		result, err := tool.Execute("tool-call", input)
		if err != nil {
			return nil, err
		}
		content := result.(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
		payload := map[string]any{}
		if err := json.Unmarshal([]byte(content), &payload); err != nil {
			t.Fatal(err)
		}
		return payload, nil
	}
	t.Fatalf("missing public Agent control tool %s", action)
	return nil, nil
}

func TestAgentControlToolsReadAndPageChildren(t *testing.T) {
	runtime, parent, children := agentControlFixture(t)
	first, err := callAgentControlTool(t, runtime, parent, "list_children", map[string]any{"limit": float64(2)})
	if err != nil {
		t.Fatal(err)
	}
	page := first["agents"].([]any)
	if len(page) != 2 || first["hasMore"] != true {
		t.Fatalf("first page: %+v", first)
	}
	next, err := callAgentControlTool(t, runtime, parent, "list_children", map[string]any{"limit": float64(2), "afterId": first["nextAfterId"]})
	if err != nil {
		t.Fatal(err)
	}
	if len(next["agents"].([]any)) != 1 || next["hasMore"] != false {
		t.Fatalf("next page: %+v", next)
	}
	child := children[0]
	original := ListMessages(runtime.store, child.ConversationId, MessageQuery{})[0]
	AppendMessage(runtime.store, MessageInput{ConversationID: child.ConversationId, Role: MessageRoleAssistant, Kind: "chat", Text: "evidence alpha"})
	AppendMessage(runtime.store, MessageInput{ConversationID: child.ConversationId, Role: MessageRoleAssistant, Kind: "chat", Text: "evidence beta"})
	read, err := callAgentControlTool(t, runtime, parent, "read_agent", map[string]any{"agentId": child.Id, "sinceSeq": float64(original.Seq), "limit": float64(1)})
	if err != nil {
		t.Fatal(err)
	}
	messages := read["messages"].([]any)
	if len(messages) != 1 || messages[0].(map[string]any)["text"] != "evidence alpha" || read["hasMore"] != true {
		t.Fatalf("read page: %+v", read)
	}
	nextRead, err := callAgentControlTool(t, runtime, parent, "read_agent", map[string]any{"agentId": child.Id, "sinceSeq": read["nextSeq"], "limit": float64(1)})
	if err != nil {
		t.Fatal(err)
	}
	if nextRead["messages"].([]any)[0].(map[string]any)["text"] != "evidence beta" || nextRead["hasMore"] != false {
		t.Fatalf("next read: %+v", nextRead)
	}
}

func TestAgentControlMessageQueuesOnceAndStopPreservesHistory(t *testing.T) {
	runtime, parent, children := agentControlFixture(t)
	child := children[0]
	before := ListMessages(runtime.store, child.Id, MessageQuery{})
	stopped, err := callAgentControlTool(t, runtime, parent, "stop_agent", map[string]any{"agentId": child.Id, "requestId": "stop", "reason": "adjust the task"})
	if err != nil || stopped["paused"] != true {
		t.Fatalf("stop: %+v %v", stopped, err)
	}
	input := map[string]any{"agentId": child.Id, "text": "check the second case", "requestId": "followup"}
	first, err := callAgentControlTool(t, runtime, parent, "message_agent", input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := callAgentControlTool(t, runtime, parent, "message_agent", input)
	if err != nil {
		t.Fatal(err)
	}
	if first["messageId"] != replay["messageId"] || first["state"] != "queued" {
		t.Fatalf("message replay: %+v %+v", first, replay)
	}
	after := ListMessages(runtime.store, child.Id, MessageQuery{})
	if len(after) != len(before)+1 || after[0].Id != before[0].Id || runtime.store.Task(child.TaskId).Paused == 0 {
		t.Fatalf("stop/message lost state: %+v", after)
	}
	input["text"] = "different request"
	if _, err := callAgentControlTool(t, runtime, parent, "message_agent", input); err == nil {
		t.Fatal("same requestId with changed text was accepted")
	}
}

func TestAgentControlRejectsSiblingsAndArchivedWork(t *testing.T) {
	runtime, parent, children := agentControlFixture(t)
	sibling := parent
	sibling.AgentId = children[0].Id
	for _, action := range []string{"read_agent", "list_children", "message_agent", "stop_agent"} {
		_, err := callAgentControlTool(t, runtime, sibling, action, map[string]any{"agentId": children[1].Id, "text": "interfere", "requestId": action})
		if err == nil || !strings.Contains(err.Error(), "descendant") {
			t.Fatalf("%s accepted sibling: %v", action, err)
		}
	}
	runtime.ArchiveProject("p1", "archive")
	if _, err := callAgentControlTool(t, runtime, parent, "read_agent", map[string]any{"agentId": children[0].Id}); err != nil {
		t.Fatal(err)
	}
	if _, err := callAgentControlTool(t, runtime, parent, "message_agent", map[string]any{"agentId": children[0].Id, "text": "new work", "requestId": "after-archive"}); err == nil {
		t.Fatal("archived project accepted child work")
	}
}

func TestAgentControlToolsRejectInvalidPaginationAndHideWithoutHost(t *testing.T) {
	runtime, parent, children := agentControlFixture(t)
	for _, limit := range []float64{-1, 0.5, 201} {
		if _, err := callAgentControlTool(t, runtime, parent, "read_agent", map[string]any{"agentId": children[0].Id, "limit": limit}); err == nil {
			t.Fatalf("invalid limit %v was accepted", limit)
		}
	}
	for _, tool := range AgentTools(AgentToolsInput{Workspace: t.TempDir()}) {
		if tool.Name == "read_agent" || tool.Name == "list_children" || tool.Name == "message_agent" || tool.Name == "stop_agent" {
			t.Fatalf("exposed %s without a host", tool.Name)
		}
	}
}
