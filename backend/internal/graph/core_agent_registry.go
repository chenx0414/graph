package graph

import (
	"strings"
)

type AgentRecord struct {
	Id             string `json:"id"`
	ParentId       string `json:"parentId"`
	Kind           string `json:"kind"`
	Role           string `json:"role"`
	Name           string `json:"name"`
	ConversationId string `json:"conversationId"`
	TaskId         string `json:"taskId"`
	NodeId         string `json:"nodeId"`
	ProjectId      string `json:"projectId"`
	Workspace      string `json:"workspace"`
	Model          string `json:"model"`
	CreatedAt      int64  `json:"createdAt"`
	ClosedAt       *int64 `json:"closedAt"`
	Metadata       string `json:"metadata"`
}

type AgentRegistration = AgentRecord

func agentKindValid(kind string) bool {
	switch kind {
	case "global", "project", "node", "child":
		return true
	}
	return false
}

func agentTextArg(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func agentIntArg(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func agentRecordFrom(row map[string]any) AgentRecord {
	record := AgentRecord{
		Id: kernelString(row["id"]), Kind: kernelString(row["kind"]), Role: kernelString(row["role"]),
		Name: kernelString(row["name"]), ConversationId: kernelString(row["conversation_id"]),
		TaskId: kernelString(row["task_id"]), NodeId: kernelString(row["node_id"]),
		ProjectId: kernelString(row["project_id"]), Workspace: kernelString(row["workspace"]),
		Model: kernelString(row["model"]), CreatedAt: kernelInt(row["created_at"]),
		Metadata: kernelString(row["metadata"]),
	}
	if parent := conversationNullableString(row["parent_id"]); parent != nil {
		record.ParentId = *parent
	}
	if closed := conversationNullableInt(row["closed_at"]); closed != nil {
		record.ClosedAt = closed
	}
	return record
}

func RegisterAgent(store *TaskStore, input AgentRegistration) AgentRecord {
	if strings.TrimSpace(input.Id) == "" || !agentKindValid(input.Kind) {
		Raise("invalid_input", "An agent id and a global, project, node or child kind are required")
	}
	createdAt := input.CreatedAt
	if createdAt == 0 {
		createdAt = NowMillis()
	}
	metadata := input.Metadata
	if metadata == "" {
		metadata = "{}"
	}
	kernelExec(store.Db, `INSERT INTO agents(id,parent_id,kind,role,name,conversation_id,task_id,node_id,
		project_id,workspace,model,created_at,closed_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,kind=excluded.kind,role=excluded.role,
		name=excluded.name,conversation_id=excluded.conversation_id,task_id=excluded.task_id,
		node_id=excluded.node_id,project_id=excluded.project_id,workspace=excluded.workspace,
		model=excluded.model,closed_at=excluded.closed_at,
		metadata=CASE WHEN excluded.metadata='{}' THEN agents.metadata ELSE excluded.metadata END`,
		input.Id, agentTextArg(input.ParentId), input.Kind, agentTextArg(input.Role), agentTextArg(input.Name),
		agentTextArg(input.ConversationId), agentTextArg(input.TaskId), agentTextArg(input.NodeId),
		agentTextArg(input.ProjectId), input.Workspace, input.Model, createdAt, agentIntArg(input.ClosedAt), metadata)
	record := AgentById(store, input.Id)
	if record == nil {
		Raise("invalid_agent", "The agent disappeared while it was registered")
	}
	return *record
}

func AgentById(store *TaskStore, id string) *AgentRecord {
	row := kernelRow(store.Db, "SELECT * FROM agents WHERE id=?", id)
	if row == nil {
		return nil
	}
	record := agentRecordFrom(row)
	return &record
}

func agentGlobalId(store *TaskStore) string {
	row := kernelRow(store.Db, "SELECT id FROM conversations WHERE role='global' ORDER BY created_seq LIMIT 1")
	if row == nil {
		return ""
	}
	return kernelString(row["id"])
}

func agentProjectWorkspace(store *TaskStore, projectId string) string {
	if projectId == "" {
		return ""
	}
	row := kernelRow(store.Db, "SELECT root FROM projects WHERE id=?", projectId)
	if row == nil {
		return ""
	}
	return kernelString(row["root"])
}

func agentSupervisorParent(store *TaskStore, conversationId string) string {
	if conversationId != "" && kernelRow(store.Db,
		"SELECT 1 FROM conversations WHERE id=? AND role IN ('global','project')", conversationId) != nil {
		return conversationId
	}
	return agentGlobalId(store)
}

func RegisterSupervisorAgent(store *TaskStore, conversationId string, role ConversationRole, title, anchorTaskId, workspace string, projectId *string, model string) AgentRecord {
	kind := string(role)
	parent := ""
	projectValue := ""
	if kind == "project" {
		parent = agentGlobalId(store)
	}
	if projectId != nil {
		projectValue = *projectId
	}
	return RegisterAgent(store, AgentRegistration{
		Id: conversationId, ParentId: parent, Kind: kind, Role: kind, Name: title,
		ConversationId: conversationId, TaskId: anchorTaskId, ProjectId: projectValue,
		Workspace: agentProjectWorkspace(store, workspace), Model: model,
	})
}

func RegisterNodeAgent(store *TaskStore, taskId, nodeId, role, projectId string) AgentRecord {
	row := kernelRow(store.Db, "SELECT project_id,conversation_id FROM tasks WHERE id=?", taskId)
	if row == nil {
		Raise("not_found", "Task not found")
	}
	if strings.TrimSpace(nodeId) == "" {
		Raise("invalid_input", "A node id is required")
	}
	if role == "" {
		role = "worker"
	}
	conversationId := kernelString(row["conversation_id"])
	if projectId == "" {
		projectId = kernelString(row["project_id"])
	}
	return RegisterAgent(store, AgentRegistration{
		Id: taskId + "/" + nodeId, ParentId: agentSupervisorParent(store, conversationId), Kind: "node",
		Role: role, Name: nodeId, ConversationId: conversationId, TaskId: taskId, NodeId: nodeId,
		ProjectId: projectId, Workspace: agentProjectWorkspace(store, projectId),
	})
}

func AgentChildren(store *TaskStore, parentId string) []AgentRecord {
	var rows []map[string]any
	if parentId == "" {
		rows = kernelRows(store.Db, "SELECT * FROM agents WHERE parent_id IS NULL ORDER BY rowid")
	} else {
		rows = kernelRows(store.Db, "SELECT * FROM agents WHERE parent_id=? ORDER BY rowid", parentId)
	}
	records := make([]AgentRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, agentRecordFrom(row))
	}
	return records
}

func agentRecords(store *TaskStore) []AgentRecord {
	rows := kernelRows(store.Db, "SELECT * FROM agents ORDER BY rowid")
	records := make([]AgentRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, agentRecordFrom(row))
	}
	return records
}

func agentSubtreeOf(records []AgentRecord, rootId string) []AgentRecord {
	if rootId == "" {
		return []AgentRecord{}
	}
	children := map[string][]AgentRecord{}
	root := (*AgentRecord)(nil)
	for index := range records {
		record := records[index]
		if record.Id == rootId {
			root = &record
		}
		if record.ParentId != "" {
			children[record.ParentId] = append(children[record.ParentId], record)
		}
	}
	out := []AgentRecord{}
	if root != nil {
		out = append(out, *root)
	}
	queue := []string{rootId}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, child := range children[id] {
			out = append(out, child)
			queue = append(queue, child.Id)
		}
	}
	return out
}

func AgentSubtree(store *TaskStore, rootId string) []AgentRecord {
	return agentSubtreeOf(agentRecords(store), rootId)
}
