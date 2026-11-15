package graph

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type AgentSpawnInput struct {
	Objective string
	Name      string
	Model     string
	Workspace string
	RequestId string
}

type AgentSpawnParent struct {
	AgentId        string
	ConversationId string
	TaskId         string
	NodeId         string
	ProjectId      string
	Workspace      string
}

type AgentSpawnReceipt struct {
	AgentId        string `json:"agentId"`
	ConversationId string `json:"conversationId"`
	TaskId         string `json:"taskId"`
}

func (runtime *TaskRuntime) SpawnAgent(parent AgentSpawnParent, input AgentSpawnInput) any {
	runtime.ensureOpen()
	objective := strings.TrimSpace(input.Objective)
	if objective == "" {
		Raise("invalid_input", "objective is required: say what the child Agent must accomplish")
	}
	if parent.AgentId == "" {
		Raise("invalid_input", "The spawning Agent has no identity")
	}
	workspaceMode := strings.TrimSpace(input.Workspace)
	if workspaceMode == "" {
		workspaceMode = "isolated"
	}
	if workspaceMode != "isolated" && workspaceMode != "read-only" {
		Raise("invalid_input", "workspace must be isolated or read-only")
	}
	requestId := strings.TrimSpace(input.RequestId)
	if requestId == "" {
		requestId = graphUUID()
	}
	runtime.spawnLimits(parent)
	result := runtime.store.Command("agent-spawn:"+requestId, requestId, map[string]any{
		"parent": parent.AgentId, "objective": objective, "name": input.Name, "model": input.Model,
		"workspace": workspaceMode,
	}, func() any {
		return runtime.spawnAgentTransaction(parent, input, workspaceMode)
	})
	record, _ := jsonRecord(result)
	if record == nil {
		Raise("invalid_receipt", "The spawn receipt is invalid")
	}
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return record
}

func (runtime *TaskRuntime) spawnAgentTransaction(parent AgentSpawnParent, input AgentSpawnInput, workspaceMode string) map[string]any {
	childId := graphUUID()
	taskId := graphUUID()
	title := strings.TrimSpace(input.Name)
	if title == "" {
		title = "子 Agent"
	}
	projectId := parent.ProjectId
	if projectId != "" {
		if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", projectId) == nil {
			Raise("invalid_input", "The parent project is not configured")
		}
	}
	workspace := parent.Workspace
	workspaceProjectId := agentSpawnWorkspaceProject(runtime.store, parent, projectId)
	if workspaceMode == "isolated" {
		workspace = filepath.Join(runtime.stateDir, "children", childId)
		if err := os.MkdirAll(workspace, 0o700); err != nil {
			Raise("invalid_workspace", "The child workspace cannot be created: "+err.Error())
		}
		workspaceProjectId = "child:" + childId
		runtime.store.RegisterProject(workspaceProjectId, workspace, agentSpawnGrants(runtime.store, projectId))
	}
	if workspace == "" {
		Raise("invalid_workspace", "The child Agent needs a workspace")
	}
	model := runtime.agentSpawnModel(parent, input.Model)
	sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(created_seq),0)+1 AS seq FROM tasks")["seq"])
	createdAt := NowMillis()
	var conversationProjectId *string
	if projectId != "" {
		value := projectId
		conversationProjectId = &value
	}
	runtime.store.CreateConversation(childId, conversationProjectId, workspaceProjectId, taskId, title, sequence, createdAt)
	runtime.store.AssignConversationRole(childId, ConversationChild)
	runtime.store.CreateConversationTask(taskId, workspaceProjectId, input.Objective, string(PhaseChatting), sequence, childId)
	runtime.createMasterNode(taskId)
	if model != "" && model != stringValue(runtime.masterModel()) {
		runtime.bindChildModel(taskId, model)
	}
	RegisterAgent(runtime.store, AgentRegistration{
		Id: childId, ParentId: parent.AgentId, Kind: "child", Role: "child", Name: title,
		ConversationId: childId, TaskId: taskId, ProjectId: projectId, Workspace: workspace, Model: model,
	})
	AppendMessage(runtime.store, MessageInput{
		ConversationID: childId, Role: MessageRoleUser, Kind: "chat", Text: input.Objective,
		State: MessageStatePending,
	})
	runtime.store.SetNodePending(taskId, "master")
	runtime.store.Event(taskId, "conversation.created", map[string]any{"conversationId": childId, "parentAgentId": parent.AgentId})
	runtime.store.Event(taskId, "agent.spawned", map[string]any{
		"agentId": childId, "parentAgentId": parent.AgentId, "workspace": workspace, "model": model,
	})
	return map[string]any{"agentId": childId, "conversationId": childId, "taskId": taskId}
}

func agentSpawnWorkspaceProject(store *TaskStore, parent AgentSpawnParent, projectId string) string {
	if parent.ConversationId != "" {
		if row := kernelRow(store.Db, "SELECT workspace_project_id FROM conversations WHERE id=?", parent.ConversationId); row != nil {
			if value := kernelString(row["workspace_project_id"]); value != "" {
				return value
			}
		}
	}
	if projectId != "" {
		return projectId
	}
	return ""
}

func agentSpawnGrants(store *TaskStore, projectId string) string {
	if projectId == "" {
		return "[]"
	}
	row := kernelRow(store.Db, "SELECT grants FROM projects WHERE id=?", projectId)
	if row == nil {
		return "[]"
	}
	return kernelString(row["grants"])
}

func (runtime *TaskRuntime) agentSpawnModel(parent AgentSpawnParent, requested string) string {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		if agent := AgentById(runtime.store, parent.AgentId); agent != nil && agent.Model != "" {
			requested = agent.Model
		}
	}
	if requested == "" && parent.TaskId != "" {
		nodeId := parent.NodeId
		if nodeId == "" {
			nodeId = "master"
		}
		if row := kernelRow(runtime.store.Db, "SELECT COALESCE(json_extract(spec,'$.model'),'') AS model,instance_id FROM nodes WHERE task_id=? AND id=?", parent.TaskId, nodeId); row != nil {
			requested = kernelString(row["model"])
			if requested == "" {
				requested = kernelString(kernelRow(runtime.store.Db, "SELECT model FROM instances WHERE id=?", kernelString(row["instance_id"]))["model"])
			}
		}
	}
	if requested == "" {
		if master := runtime.masterModel(); master != nil {
			requested = *master
		}
	}
	entries := runtime.liveConfiguredEntries()
	if len(entries) > 0 {
		configured := false
		for _, entry := range entries {
			if entry.Id == requested {
				configured = true
				break
			}
		}
		if !configured {
			Raise("model_unavailable", "The selected child model is not configured")
		}
	}
	return requested
}

func (runtime *TaskRuntime) bindChildModel(taskId, model string) {
	specRow := kernelRow(runtime.store.Db, "SELECT spec,instance_id FROM nodes WHERE task_id=? AND id='master'", taskId)
	if specRow == nil {
		Raise("invalid_state", "The child Agent has no master node")
	}
	spec := NodeSpec{}
	if err := json.Unmarshal([]byte(kernelString(specRow["spec"])), &spec); err != nil {
		panic(err)
	}
	spec.Model = &model
	runtime.store.SetNodeSpec(taskId, "master", CanonicalJSON(spec))
	runtime.store.SetInstanceModel(kernelString(specRow["instance_id"]), model)
}

func (runtime *TaskRuntime) spawnLimits(parent AgentSpawnParent) {
	maxAgents, spawnDepth, childrenPerAgent := runtime.spawnLimitValues()
	row := kernelRow(runtime.store.Db, "SELECT COUNT(*) AS n FROM agents")
	if kernelInt(row["n"]) >= int64(maxAgents) {
		Raise("agent_limit", fmt.Sprintf("The project already has %d Agents; limits.maxAgents is %d", kernelInt(row["n"]), maxAgents))
	}
	children := kernelRow(runtime.store.Db, "SELECT COUNT(*) AS n FROM agents WHERE parent_id=? AND kind='child'", parent.AgentId)
	if kernelInt(children["n"]) >= int64(childrenPerAgent) {
		Raise("agent_limit", fmt.Sprintf("This Agent already spawned %d children; limits.childrenPerAgent is %d", kernelInt(children["n"]), childrenPerAgent))
	}
	depth := 0
	current := parent.AgentId
	for current != "" {
		record := AgentById(runtime.store, current)
		if record == nil {
			break
		}
		depth++
		current = record.ParentId
	}
	if depth >= spawnDepth {
		Raise("agent_limit", fmt.Sprintf("The spawn depth %d reaches limits.spawnDepth %d", depth, spawnDepth))
	}
}

func (runtime *TaskRuntime) spawnLimitValues() (int, int, int) {
	maxAgents, spawnDepth, childrenPerAgent := DefaultMaxAgents, DefaultSpawnDepth, DefaultChildrenPerAgent
	if runtime.limits != nil {
		if runtime.limits.MaxAgents > 0 {
			maxAgents = runtime.limits.MaxAgents
		}
		if runtime.limits.SpawnDepth > 0 {
			spawnDepth = runtime.limits.SpawnDepth
		}
		if runtime.limits.ChildrenPerAgent > 0 {
			childrenPerAgent = runtime.limits.ChildrenPerAgent
		}
	}
	return maxAgents, spawnDepth, childrenPerAgent
}
