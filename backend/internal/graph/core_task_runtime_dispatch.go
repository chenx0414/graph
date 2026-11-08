package graph

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

func (runtime *TaskRuntime) RunReady() ExecutionDispatch {
	runtime.ensureOpen()
	return runtime.execution.RunReady()
}

func (runtime *TaskRuntime) Drive() ExecutionDispatch {
	runtime.ensureOpen()
	return runtime.execution.Drive()
}

func (runtime *TaskRuntime) Report(id string, generation int, result OperationResult) {
	runtime.ensureOpen()
	runtime.execution.Report(id, generation, result)
}

func (runtime *TaskRuntime) Reconcile(id string) {
	runtime.ensureOpen()
	runtime.execution.Reconcile(id)
}

func (runtime *TaskRuntime) CheckProjects(projects []ProjectConfig) {
	runtime.ensureOpen()
	for _, project := range projects {
		if strings.TrimSpace(project.Id) == "" || strings.TrimSpace(project.Root) == "" {
			Raise("invalid_input", "Project identity and root must be nonempty strings")
		}
		root, err := filepath.Abs(project.Root)
		if err != nil {
			root = project.Root
		}
		previous := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", project.Id)
		if previous == nil || kernelString(previous["root"]) == root {
			continue
		}
		active := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND phase IN ('discussing','running','queued')", project.Id)["count"])
		if active > 0 {
			Raise("project_conflict", "Project "+project.Id+" has tasks in flight; its root cannot change until they finish")
		}
	}
}

func (runtime *TaskRuntime) SyncProjects() {
	runtime.ensureOpen()
	configured := runtime.configuredProjects()
	runtime.CheckProjects(configured)
	runtime.store.Transaction(func() any {
		for _, project := range configured {
			root, err := filepath.Abs(project.Root)
			if err != nil {
				root = project.Root
			}
			grants := taskRuntimeGrants(project.Grants)
			previous := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", project.Id)
			if previous == nil {
				runtime.store.RegisterProject(project.Id, root, grants)
				continue
			}
			if kernelString(previous["root"]) != root {
				runtime.store.MoveProjectRoot(project.Id, root)
			}
		}
		return nil
	})
}

func (runtime *TaskRuntime) RecoverMasters() int {
	runtime.ensureOpen()
	if runtime.master == nil || runtime.masterModel() == nil || runtime.masterDefinitionVersion() == nil {
		return 0
	}
	created := 0
	runtime.store.Transaction(func() any {
		pending := kernelRows(runtime.store.Db, "SELECT id, project_id, phase FROM tasks WHERE phase IN ('discussing','chatting') ORDER BY created_seq")
		allowed := runtime.allowedProjects()
		recoverable := []map[string]any{}
		for _, task := range pending {
			phase := kernelString(task["phase"])
			projectId := kernelString(task["project_id"])
			if phase == "chatting" {
				conversation := ConversationForTask(runtime.store, kernelString(task["id"]))
				if conversation != nil && conversation.Role == ConversationHistory {
					continue
				}
			}
			if phase != "chatting" && !allowed[projectId] {
				continue
			}
			recoverable = append(recoverable, task)
			nodes := kernelRows(runtime.store.Db, "SELECT spec FROM nodes WHERE task_id=?", kernelString(task["id"]))
			hasMaster := false
			for _, node := range nodes {
				var spec NodeSpec
				if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err == nil {
					if spec.Role != nil && *spec.Role == "master" {
						hasMaster = true
					}
				}
			}
			if hasMaster {
				continue
			}
			runtime.createMasterNode(kernelString(task["id"]))
			reason := runtime.resolveUndispatchableQuestion(kernelString(task["id"]))
			if reason == "" {
				reason = "dispatch was disabled when the task was created"
			}
			runtime.store.Event(kernelString(task["id"]), "task.master_recovered", map[string]any{"reason": reason})
			created++
		}
		active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
		if active == "" {
			for _, task := range recoverable {
				if kernelString(task["phase"]) != "discussing" {
					continue
				}
				runtime.store.SetRuntimeActiveTask(kernelString(task["id"]))
				break
			}
		}
		return nil
	})
	return created
}

func (runtime *TaskRuntime) AckRsiRestart(id string) any {
	runtime.ensureOpen()
	if runtime.rsi == nil {
		Raise("rsi_unavailable", "RSI is unavailable")
	}
	result := runtime.rsi.AckRestart(id, runtime.store)
	record, _ := jsonRecord(result)
	if record != nil {
		if cleared, ok := record["cleared"].(bool); ok && cleared && runtime.autoWake {
			runtime.execution.Kick()
		}
	}
	return result
}

type TaskRuntimeProjectPrepareInput struct {
	ProjectId      string
	RequestId      string
	Initialize     bool
	CreateBaseline bool
}
