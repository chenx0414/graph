package graph

import (
	"os"
	"path/filepath"
)

type SupervisorThread struct {
	ConversationID string           `json:"conversationId"`
	TaskID         string           `json:"taskId"`
	Role           ConversationRole `json:"role"`
	ProjectID      *string          `json:"projectId"`
}

func (runtime *TaskRuntime) EnsureGlobalThread(requestID string) SupervisorThread {
	return runtime.ensureSupervisorThread(nil, requestID)
}

func (runtime *TaskRuntime) OpenProjectThread(projectID, requestID string) SupervisorThread {
	if projectID == "" {
		Raise("invalid_input", "A project is required")
	}
	runtime.EnsureGlobalThread("project:" + projectID + ":global")
	if runtime.ownCheckoutProject(projectID) {
		return runtime.EnsureGlobalThread(requestID)
	}
	return runtime.ensureSupervisorThread(&projectID, requestID)
}

func (runtime *TaskRuntime) ownCheckoutProject(projectID string) bool {
	if runtime.rsi == nil || runtime.rsi.Root == nil {
		return false
	}
	row := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", projectID)
	if row == nil {
		return false
	}
	root := kernelString(row["root"])
	own, err := filepath.Abs(*runtime.rsi.Root)
	if err != nil {
		return false
	}
	theirs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	return filepath.Clean(own) == filepath.Clean(theirs)
}

func (runtime *TaskRuntime) ensureSupervisorThread(projectID *string, requestID string) SupervisorThread {
	runtime.ensureOpen()
	role := ConversationGlobal
	scope := "supervisor:global"
	if projectID != nil {
		role = ConversationProject
		scope = "supervisor:project:" + *projectID
		if !runtime.allowedProjects()[*projectID] {
			Raise("invalid_input", "A configured project is required")
		}
	}
	result := runtime.store.Command(scope, requestID, map[string]any{"projectId": projectID}, func() any {
		query := "SELECT id FROM conversations WHERE role='global'"
		args := []any{}
		if projectID != nil {
			query = "SELECT id FROM conversations WHERE role='project' AND project_id=?"
			args = append(args, *projectID)
		}
		if row := kernelRow(runtime.store.Db, query, args...); row != nil {
			return supervisorThreadOf(ConversationRowOf(runtime.store, kernelString(row["id"])))
		}
		if projectID != nil {
			if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", *projectID) == nil {
				Raise("invalid_input", "A known project is required")
			}
		}
		id, taskID := graphUUID(), graphUUID()
		workspace := "conversation:" + id
		title := "Main"
		if projectID != nil {
			workspace = *projectID
			title = *projectID
		} else {
			root := filepath.Join(runtime.stateDir, "conversations", id)
			if err := os.MkdirAll(root, 0o700); err != nil {
				panic(err)
			}
			runtime.store.RegisterProject(workspace, root, "[]")
		}
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(created_seq),0)+1 AS seq FROM tasks")["seq"])
		runtime.store.CreateConversationTask(taskID, workspace, title, string(PhaseChatting), sequence, id)
		runtime.store.CreateConversation(id, projectID, workspace, taskID, title, sequence, NowMillis())
		runtime.store.AssignConversationRole(id, role)
		masterModelId := ""
		if model := runtime.masterModel(); model != nil {
			masterModelId = *model
		}
		RegisterSupervisorAgent(runtime.store, id, role, title, taskID, workspace, projectID, masterModelId)
		if runtime.master != nil && runtime.masterModel() != nil && runtime.masterDefinitionVersion() != nil {
			runtime.createMasterNode(taskID)
		}
		runtime.store.Event(taskID, "conversation.created", map[string]any{"conversationId": id, "projectId": projectID, "role": role})
		return supervisorThreadOf(ConversationRowOf(runtime.store, id))
	})
	if thread, ok := result.(SupervisorThread); ok {
		return thread
	}
	record, ok := jsonRecord(result)
	if !ok {
		Raise("invalid_receipt", "Supervisor receipt is invalid")
	}
	id := kernelString(record["conversationId"])
	return supervisorThreadOf(ConversationRowOf(runtime.store, id))
}

func supervisorThreadOf(row ConversationRow) SupervisorThread {
	return SupervisorThread{ConversationID: row.Id, TaskID: row.AnchorTaskId, Role: row.Role, ProjectID: row.ProjectId}
}
