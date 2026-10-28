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
	return runtime.ensureSupervisorThread(&projectID, requestID)
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
			legacy := kernelRows(runtime.store.Db, "SELECT id,archived_at FROM conversations WHERE project_id=? AND role='legacy' ORDER BY created_seq", *projectID)
			if len(legacy) > 1 || (len(legacy) == 1 && legacy[0]["archived_at"] != nil) {
				Raise("thread_selection_required", "Select the existing project thread before opening its supervisor")
			}
			if len(legacy) == 1 {
				id := kernelString(legacy[0]["id"])
				runtime.store.AssignConversationRole(id, ConversationProject)
				row := ConversationRowOf(runtime.store, id)
				runtime.store.Event(row.AnchorTaskId, "conversation.supervisor_selected", map[string]any{"conversationId": id, "projectId": *projectID})
				return supervisorThreadOf(row)
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
		runtime.store.CreateConversationTask(taskID, workspace, title, "chatting", sequence, id)
		runtime.store.CreateConversation(id, projectID, workspace, taskID, title, sequence, NowMillis())
		runtime.store.AssignConversationRole(id, role)
		if runtime.master != nil && runtime.masterModel() != nil && runtime.masterDefinitionVersion() != nil {
			runtime.createMasterNode(taskID)
		}
		runtime.store.Event(taskID, "conversation.created", map[string]any{"conversationId": id, "projectId": projectID, "role": role})
		return supervisorThreadOf(ConversationRowOf(runtime.store, id))
	})
	// Command replays are decoded JSON, while fresh receipts are typed.
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
