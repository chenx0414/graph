package graph

import (
	"encoding/json"
	"strings"
)

func (runtime *TaskRuntime) User() *TaskRuntimeUser {
	return &TaskRuntimeUser{runtime: runtime}
}

type TaskRuntimeTask struct {
	runtime *TaskRuntime
	taskId  string
}

func (user *TaskRuntimeUser) Task(taskId string) *TaskRuntimeTask {
	return &TaskRuntimeTask{runtime: user.runtime, taskId: taskId}
}

type TaskRuntimeBeginInput struct {
	ProjectId string
	Request   string
	RequestId string
}

func (user *TaskRuntimeUser) Begin(input TaskRuntimeBeginInput) Receipt {
	runtime := user.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "begin", "projectId": input.ProjectId, "request": input.Request,
	}, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		if strings.TrimSpace(input.Request) == "" || kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", input.ProjectId) == nil {
			Raise("invalid_input", "A known project and nonempty request are required")
		}
		if !runtime.allowedProjects()[input.ProjectId] {
			Raise("invalid_input", "The project is no longer part of the current configuration")
		}
		taskId := graphUUID()
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"]) + 1
		runtime.store.CreateMasterTask(taskId, input.ProjectId, input.Request, sequence)
		if runtime.master != nil && runtime.masterModel() != nil && runtime.masterDefinitionVersion() != nil {
			spec := NodeSpec{
				Id:                "master",
				Kind:              "agent",
				Action:            runtime.master.Action,
				DefinitionVersion: runtime.masterDefinitionVersion(),
				Model:             runtime.masterModel(),
				Role:              taskRuntimeStringPtr("master"),
			}
			instanceId := graphUUID()
			runtime.store.CreateNode(taskId, spec.Id, CanonicalJSON(spec), instanceId)
			runtime.insertInstance(instanceId, taskId, spec.Id, spec.DefinitionVersion, spec.Model)
			runtime.store.CreateActivation(taskId, spec.Id, 0)
			active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
			if active == "" {
				runtime.store.SetRuntimeActiveTask(taskId)
			}
		} else {
			runtime.refuseUndispatchableTask(taskId)
		}
		return map[string]any{
			"taskId": taskId,
			"cursor": runtime.store.Event(taskId, "task.created", map[string]any{"request": input.Request, "configRevision": runtime.configRevision()}),
		}
	})
	return taskRuntimeReceipt(result)
}

func taskRuntimeStringPtr(value string) *string {
	return &value
}

func taskRuntimeReceipt(result any) Receipt {
	record, _ := jsonRecord(result)
	receipt := Receipt{}
	if record != nil {
		if value, ok := record["taskId"].(string); ok {
			receipt.TaskId = value
		}
		if value, ok := record["cursor"].(float64); ok {
			receipt.Cursor = int(value)
		}
	}
	return receipt
}

func (runtime *TaskRuntime) insertInstance(id, taskId, nodeId string, definitionVersion *string, model *string) string {
	runtime.store.CreateInstance(id, taskId, nodeId, definitionVersion, model, 0, 1)
	return id
}

type TaskRuntimePauseInput struct {
	RequestId string
}

func (task *TaskRuntimeTask) Pause(requestId string) Receipt {
	receipt, stoppedMaster := task.setPaused(true, requestId)
	if stoppedMaster {
		task.runtime.execution.StopActiveMasterTurns(task.taskId)
	}
	return receipt
}

func (task *TaskRuntimeTask) Resume(requestId string) Receipt {
	receipt, _ := task.setPaused(false, requestId)
	if task.runtime.autoWake {
		task.runtime.execution.Kick()
	}
	return receipt
}

func (task *TaskRuntimeTask) setPaused(paused bool, requestId string) (Receipt, bool) {
	runtime := task.runtime
	runtime.ensureOpen()
	stoppedMaster := false
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": taskRuntimePauseType(paused), "taskId": task.taskId,
	}, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		runtime.store.SetTaskPaused(task.taskId, paused)
		if paused {
			stoppedMaster = pauseMasterTurn(runtime, task.taskId, requestId)
		} else {
			ClosePause(runtime.kernel, task.taskId)
			ResumePauseContinuations(runtime.store, task.taskId)
		}
		eventType := "task.resumed"
		if paused {
			eventType = "task.pause_requested"
		}
		return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, eventType, map[string]any{})}
	})
	return taskRuntimeReceipt(result), stoppedMaster
}

func pauseMasterTurn(runtime *TaskRuntime, taskId, requestId string) bool {
	OpenPause(runtime.kernel, taskId)
	active := kernelRow(runtime.store.Db, `SELECT o.id FROM operations o
      JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
      WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
        AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`, taskId)
	if active == nil {
		return false
	}
	return AwaitPauseContinuation(runtime.store, requestId, taskId, kernelString(active["id"]))
}

func taskRuntimePauseType(paused bool) string {
	if paused {
		return "pause"
	}
	return "resume"
}

func (task *TaskRuntimeTask) Abandon(requestId string, reason *string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "abandon", "taskId": task.taskId, "reason": reasonValue(reason),
	}, func(tx *TaskStore) any {
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.execution.Abandon(task.taskId, reason, false),
		}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return taskRuntimeReceipt(result)
}

type taskRuntimeUnusedBudgetInput struct {
	NodeId    string
	Tokens    *int64
	RequestId string
}

func (task *TaskRuntimeTask) Answer(questionId string, answer Answer, requestId string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "answer", "taskId": task.taskId, "questionId": questionId, "answer": answer,
	}, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		if answer.Type == "pause" {
			runtime.store.SetTaskPaused(task.taskId, true)
			pauseMasterTurn(runtime, task.taskId, requestId)
			runtime.store.Event(task.taskId, "task.pause_requested", map[string]any{"questionId": questionId})
			runtime.execution.Answer(task.taskId, questionId, answer)
			return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, "question.answered", map[string]any{"questionId": questionId, "answer": answer})}
		}
		if runtime.receiveRoutedUserAnswer(task.taskId, questionId, answer) {
			return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, "question.answered", map[string]any{"questionId": questionId, "answer": answer})}
		}
		if kernelRow(runtime.store.Db, "SELECT id FROM questions WHERE id=? AND task_id=? AND route_stage IN ('project','global') AND status='open'", questionId, task.taskId) != nil {
			Raise("permission", "This question is being handled by a supervisor")
		}
		runtime.answerUndispatchableTask(task.taskId, questionId, answer)
		runtime.execution.Answer(task.taskId, questionId, answer)
		return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, "question.answered", map[string]any{"questionId": questionId, "answer": answer})}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return taskRuntimeReceipt(result)
}

func (task *TaskRuntimeTask) Say(text string, requestId string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "say", "taskId": task.taskId, "text": text,
	}, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		current := runtime.store.Task(task.taskId)
		if strings.TrimSpace(text) == "" {
			Raise("invalid_input", "A nonempty message is required")
		}
		if current.AcceptedProposal != nil {
			Raise("requirements_locked", "Confirmed requirements need an explicit impact review")
		}
		runtime.store.BumpRequirementVersion(task.taskId)
		for _, row := range kernelRows(runtime.store.Db, "SELECT id,status,spec FROM nodes WHERE task_id=?", task.taskId) {
			var spec NodeSpec
			if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
				panic(err)
			}
			if spec.Role == nil || *spec.Role != "master" {
				continue
			}
			status := kernelString(row["status"])
			if status == "preparing" || status == "running" || HasLockedQuestion(runtime.store, task.taskId, kernelString(row["id"])) {
				continue
			}
			runtime.store.SetNodePending(task.taskId, kernelString(row["id"]))
		}
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.store.Event(task.taskId, "requirement.changed", map[string]any{"text": text, "requirementVersion": current.RequirementVersion + 1}),
		}
	})
	return taskRuntimeReceipt(result)
}

type TaskRuntimeAcceptInput struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	RequestId       string
}

func (task *TaskRuntimeTask) Accept(input TaskRuntimeAcceptInput) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	runtime.git.RequireTargetBranch(runtime.store.Task(task.taskId).ProjectID, input.TargetBranch)
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "accept", "taskId": task.taskId, "proposalVersion": input.ProposalVersion,
		"draftRevision": input.DraftRevision, "targetBranch": input.TargetBranch,
	}, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		current := runtime.store.Task(task.taskId)
		row := kernelRow(runtime.store.Db, "SELECT requirement_version,spec,draft_revision,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?",
			task.taskId, input.ProposalVersion)
		if row == nil || row["deleted_at"] != nil || row["archived_at"] != nil ||
			current.LatestProposal != int64(input.ProposalVersion) ||
			kernelInt(row["requirement_version"]) != current.RequirementVersion {
			Raise("stale_proposal", "Only the current requirement proposal can be accepted")
		}
		if input.DraftRevision != int(kernelInt(row["draft_revision"])) {
			Raise("stale_proposal", "This draft changed after it was reviewed; read it again before accepting")
		}
		if current.AcceptedProposal != nil {
			Raise("already_accepted", "Task already has confirmed requirements")
		}
		if strings.TrimSpace(input.TargetBranch) == "" {
			Raise("invalid_input", "A target branch is required")
		}
		var proposal NativeProposal
		if err := json.Unmarshal([]byte(kernelString(row["spec"])), &proposal); err != nil {
			panic(err)
		}
		ValidateProposal(proposal)
		MaterializeGraph(runtime.kernel, task.taskId, ParseGraphDefinition(proposal.Definition), "Confirmed task graph")
		active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
		phase := PhaseQueued
		if active == "" || active == task.taskId {
			phase = PhaseRunning
		}
		runtime.store.AcceptProposal(task.taskId, input.ProposalVersion, input.TargetBranch, string(phase))
		if active == "" || active == task.taskId {
			runtime.store.SetRuntimeActiveTask(task.taskId)
		}
		return map[string]any{
			"taskId":          task.taskId,
			"proposalVersion": input.ProposalVersion,
			"draftRevision":   kernelInt(row["draft_revision"]),
			"cursor":          runtime.store.Event(task.taskId, "task.accepted", map[string]any{"proposalVersion": input.ProposalVersion, "targetBranch": input.TargetBranch}),
		}
	})
	runtime.git.PrepareTask(task.taskId, input.TargetBranch)
	if NewKernelStore(runtime.store).LatestRevision(task.taskId) != nil {
		WakeMaster(runtime.store, WakeIntent{TaskID: task.taskId, Kind: "graph_ready", DedupeKey: task.taskId + ":ready", Data: map[string]any{"graphId": task.taskId}, HasData: true})
	}
	return taskRuntimeReceipt(result)
}
