package graph

import "encoding/json"

type ProjectLifecycle struct {
	ProjectID        string `json:"projectId"`
	Archived         bool   `json:"archived"`
	ArchivedAt       *int64 `json:"archivedAt"`
	State            string `json:"state"`
	ActiveExecutions int64  `json:"activeExecutions"`
}

func (runtime *TaskRuntime) projectLifecycleInTransaction(projectID string) ProjectLifecycle {
	row := kernelRow(runtime.store.Db, "SELECT archived_at FROM projects WHERE id=?", projectID)
	if row == nil || !runtime.allowedProjects()[projectID] {
		Raise("not_found", "Project not found")
	}
	active := kernelRow(runtime.store.Db, `SELECT
 (SELECT COUNT(*) FROM kernel_executions e JOIN tasks t ON t.id=e.task_id WHERE t.project_id=? AND e.state='running') +
 (SELECT COUNT(*) FROM operations o JOIN tasks t ON t.id=o.task_id WHERE t.project_id=? AND t.phase!='chatting' AND o.worker_active=1) AS total`, projectID, projectID)
	archived := row["archived_at"] != nil
	state := "active"
	if archived {
		state = "archived"
		if kernelInt(active["total"]) > 0 {
			state = "pausing"
		}
	}
	return ProjectLifecycle{ProjectID: projectID, Archived: archived, ArchivedAt: conversationNullableInt(row["archived_at"]), State: state, ActiveExecutions: kernelInt(active["total"])}
}

func (runtime *TaskRuntime) ProjectLifecycle(projectID string) ProjectLifecycle {
	runtime.ensureOpen()
	runtime.store.txMu.Lock()
	defer runtime.store.txMu.Unlock()
	return runtime.projectLifecycleInTransaction(projectID)
}

func (runtime *TaskRuntime) ArchiveProject(projectID, requestID string) ProjectLifecycle {
	runtime.ensureOpen()
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	result := runtime.store.Command("project:archive:"+projectID, requestID, map[string]any{"projectId": projectID}, func() any {
		before := runtime.projectLifecycleInTransaction(projectID)
		if !before.Archived {
			runtime.store.ArchiveProject(projectID, NowMillis())
			runtime.store.PauseProjectWork(projectID)
			runtime.store.PauseProjectTasks(projectID)
			for _, row := range kernelRows(runtime.store.Db, `SELECT id FROM tasks WHERE project_id=? AND phase NOT IN ('chatting','completed','stopping','stopped','abandoned')`, projectID) {
				runtime.kernel.SetNativePause(kernelString(row["id"]), true, "", 0)
			}
			runtime.store.Event(nil, "project.archived", map[string]any{"projectId": projectID, "requestId": requestID})
		}
		return runtime.projectLifecycleInTransaction(projectID)
	})
	return projectLifecycleReceipt(result)
}

func (runtime *TaskRuntime) RestoreProject(projectID, requestID string) ProjectLifecycle {
	runtime.ensureOpen()
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	result := runtime.store.Command("project:restore:"+projectID, requestID, map[string]any{"projectId": projectID}, func() any {
		before := runtime.projectLifecycleInTransaction(projectID)
		if before.Archived {
			runtime.store.RestoreProject(projectID)
			runtime.store.Event(nil, "project.restored", map[string]any{"projectId": projectID, "requestId": requestID})
		}
		return runtime.projectLifecycleInTransaction(projectID)
	})
	return projectLifecycleReceipt(result)
}

func projectLifecycleReceipt(value any) ProjectLifecycle {
	if item, ok := value.(ProjectLifecycle); ok {
		return item
	}
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var item ProjectLifecycle
	if err := json.Unmarshal(data, &item); err != nil {
		panic(err)
	}
	return item
}

func (runtime *TaskRuntime) ResumeWork(workID, requestID string) WorkRecord {
	return runtime.resumeWork(workID, requestID, nil)
}

type WorkResumeInstruction struct {
	WorkID, RequestID, SourceMessageID, Instruction, CallerTaskID string
}

func (runtime *TaskRuntime) ResumeWorkBySupervisor(input WorkResumeInstruction) WorkRecord {
	return runtime.resumeWork(input.WorkID, input.RequestID, &input)
}

func (runtime *TaskRuntime) resumeWork(workID, requestID string, instruction *WorkResumeInstruction) WorkRecord {
	runtime.ensureOpen()
	graphDatabaseMu.Lock()
	result := func() any {
		defer graphDatabaseMu.Unlock()
		payload := map[string]any{"workId": workID}
		if instruction != nil {
			payload["instruction"] = instruction
		}
		return runtime.store.Command("work:resume:"+workID, requestID, payload, func() any {
			work := runtime.store.workInTransaction(workID)
			if work.ProjectID == nil {
				Raise("invalid_input", "Work has no project")
			}
			project := runtime.projectLifecycleInTransaction(*work.ProjectID)
			if project.Archived {
				Raise("project_archived", "Restore the project before resuming work")
			}
			if work.State == "completed" || work.State == "cancelled" {
				Raise("invalid_input", "Finished work cannot be resumed")
			}
			actor := "user"
			if instruction != nil {
				caller := ConversationForTask(runtime.store, instruction.CallerTaskID)
				if caller == nil || caller.AnchorTaskId != instruction.CallerTaskID || (caller.Role != ConversationGlobal && (caller.Role != ConversationProject || caller.ProjectId == nil || *caller.ProjectId != *work.ProjectID)) {
					Raise("permission", "This supervisor cannot resume work for that project")
				}
				requireUserResumeInstruction(runtime.store, instruction.CallerTaskID, *work.ProjectID, instruction.SourceMessageID, instruction.Instruction)
				actor = "supervisor"
			}
			runtime.store.ResumeWorkExecution(workID)
			runtime.resumeArchivePausedWorkGraphs(workID)
			runtime.store.Event(nil, "work.resumed", map[string]any{"workId": workID, "projectId": *work.ProjectID, "actor": actor, "instruction": instruction})
			return runtime.store.workInTransaction(workID)
		})
	}()
	if runtime.autoWake {
		runtime.execution.Kick()
		go runtime.recoverWorkGraphs()
		go runtime.recoverTransferredGraphPreparations()
	}
	return workReceipt(result)
}

func (runtime *TaskRuntime) resumeArchivePausedWorkGraphs(workID string) {
	for _, graphID := range runtime.store.ArchivePausedWorkGraphs(workID) {
		runtime.store.ClearArchivePause(graphID)
		runtime.store.SetTaskPaused(graphID, false)
		runtime.kernel.SetNativePause(graphID, false, "", 0)
	}
}
