package graph

import (
	"encoding/json"
	"strings"
)

// User returns the user side of the runtime.
func (runtime *TaskRuntime) User() *TaskRuntimeUser {
	return &TaskRuntimeUser{runtime: runtime}
}

// TaskRuntimeTask is one task of the user side.
type TaskRuntimeTask struct {
	runtime *TaskRuntime
	taskId  string
}

// Task returns the commands of one task.
func (user *TaskRuntimeUser) Task(taskId string) *TaskRuntimeTask {
	return &TaskRuntimeTask{runtime: user.runtime, taskId: taskId}
}

// BeginInput starts one new task.
type TaskRuntimeBeginInput struct {
	ProjectId string
	Request   string
	RequestId string
}

// Begin starts one new task.
func (user *TaskRuntimeUser) Begin(input TaskRuntimeBeginInput) Receipt {
	runtime := user.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "begin", "projectId": input.ProjectId, "request": input.Request,
	}, func() any {
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
			kernelExec(runtime.store.Db, "INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)", taskId, spec.Id, CanonicalJSON(spec), instanceId)
			runtime.insertInstance(instanceId, taskId, spec.Id, spec.DefinitionVersion, spec.Model)
			CreateActivation(runtime.store, taskId, spec.Id, 0)
			active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
			if active == "" {
				kernelExec(runtime.store.Db, "UPDATE runtime SET active_task=?", taskId)
			}
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

// insertInstance records the instance row of one node.
func (runtime *TaskRuntime) insertInstance(id, taskId, nodeId string, definitionVersion *string, model *string) string {
	budget := runtime.liveBudget()
	unlimited := 0
	amount := int64(0)
	if budget == nil {
		unlimited = 1
	} else {
		amount = *budget
	}
	kernelExec(runtime.store.Db, "INSERT INTO instances(id,task_id,node_id,definition_version,model,budget,unlimited) VALUES(?,?,?,?,?,?,?)",
		id, taskId, nodeId, definitionVersion, model, amount, unlimited)
	return id
}

// TaskRuntimePauseInput is the input of one pause or resume.
type TaskRuntimePauseInput struct {
	RequestId string
}

// Pause stops the dispatch of a task.
func (task *TaskRuntimeTask) Pause(requestId string) Receipt {
	receipt, stoppedMaster := task.setPaused(true, requestId)
	if stoppedMaster {
		task.runtime.execution.StopActiveMasterTurns(task.taskId)
	}
	return receipt
}

// Resume restarts the dispatch of a task.
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
	}, func() any {
		pausedValue := 0
		if paused {
			pausedValue = 1
		}
		runtime.store.SetTaskPaused(task.taskId, pausedValue != 0)
		if paused {
			OpenPause(runtime.kernel, task.taskId)
			active := kernelRow(runtime.store.Db, `SELECT o.id FROM operations o
              JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
              WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
                AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`, task.taskId)
			if active != nil {
				stoppedMaster = AwaitPauseContinuation(runtime.store, requestId, task.taskId, kernelString(active["id"]))
			}
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

func taskRuntimePauseType(paused bool) string {
	if paused {
		return "pause"
	}
	return "resume"
}

// Abandon stops the task for good.
func (task *TaskRuntimeTask) Abandon(requestId string, reason *string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "abandon", "taskId": task.taskId, "reason": reasonValue(reason),
	}, func() any {
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

// TaskRuntimeBudgetInput is the input of one budget change.
type TaskRuntimeBudgetInput struct {
	NodeId    string
	Tokens    *int64
	RequestId string
}

// SetBudget changes the budget policy of one node.
func (task *TaskRuntimeTask) SetBudget(input TaskRuntimeBudgetInput) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	if strings.TrimSpace(input.NodeId) == "" {
		Raise("invalid_input", "A nodeId is required")
	}
	if input.Tokens != nil && *input.Tokens <= 0 {
		Raise("invalid_input", "Budget must be a positive integer or null")
	}
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "set_budget", "taskId": task.taskId, "nodeId": input.NodeId, "tokens": input.Tokens,
	}, func() any {
		if runtime.kernel.LatestRevision(task.taskId) != nil {
			runtime.kernel.SetAuthorizedBudget(task.taskId, input.NodeId, input.Tokens)
			changes := runtime.store.ResolveNodeBudgetQuestions(task.taskId, input.NodeId, map[string]any{"type": "set_budget", "tokens": input.Tokens})
			if changes > 0 {
				CloseUserWait(runtime.store, task.taskId, input.NodeId)
			}
			return map[string]any{
				"taskId": task.taskId,
				"cursor": runtime.store.Event(task.taskId, "instance.budget_changed", map[string]any{"nodeId": input.NodeId, "tokens": input.Tokens, "nextExecution": true}),
			}
		}
		instance := kernelRow(runtime.store.Db, "SELECT id FROM instances WHERE task_id=? AND node_id=?", task.taskId, input.NodeId)
		if instance == nil {
			Raise("not_found", "Unknown agent node")
		}
		SetBudget(runtime.store, kernelString(instance["id"]), input.Tokens)
		changes := runtime.store.ResolveNodeBudgetQuestions(task.taskId, input.NodeId, map[string]any{"type": "set_budget", "tokens": input.Tokens})
		if changes > 0 {
			CloseUserWait(runtime.store, task.taskId, input.NodeId)
			stillOpen := kernelRow(runtime.store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'", task.taskId, input.NodeId)
			if stillOpen == nil {
				kernelExec(runtime.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", task.taskId, input.NodeId)
			}
		}
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.store.Event(task.taskId, "instance.budget_changed", map[string]any{"nodeId": input.NodeId, "tokens": input.Tokens}),
		}
	})
	return taskRuntimeReceipt(result)
}

// Answer resolves one open question.
func (task *TaskRuntimeTask) Answer(questionId string, answer Answer, requestId string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "answer", "taskId": task.taskId, "questionId": questionId, "answer": answer,
	}, func() any {
		runtime.execution.Answer(task.taskId, questionId, answer)
		return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, "question.answered", map[string]any{"questionId": questionId, "answer": answer})}
	})
	return taskRuntimeReceipt(result)
}

// Say adds a user message to the requirement of a task.
func (task *TaskRuntimeTask) Say(text string, requestId string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "say", "taskId": task.taskId, "text": text,
	}, func() any {
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
			kernelExec(runtime.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", task.taskId, kernelString(row["id"]))
		}
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.store.Event(task.taskId, "requirement.changed", map[string]any{"text": text, "requirementVersion": current.RequirementVersion + 1}),
		}
	})
	return taskRuntimeReceipt(result)
}

// TaskRuntimeAcceptInput is the input of one acceptance.
type TaskRuntimeAcceptInput struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	RequestId       string
}

// Accept confirms the current proposal of a task.
func (task *TaskRuntimeTask) Accept(input TaskRuntimeAcceptInput) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	runtime.git.RequireTargetBranch(runtime.store.Task(task.taskId).ProjectID, input.TargetBranch)
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "accept", "taskId": task.taskId, "proposalVersion": input.ProposalVersion,
		"draftRevision": input.DraftRevision, "targetBranch": input.TargetBranch,
	}, func() any {
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
		phase := "queued"
		if active == "" || active == task.taskId {
			phase = "running"
		}
		runtime.store.AcceptProposal(task.taskId, input.ProposalVersion, input.TargetBranch, phase)
		if active == "" || active == task.taskId {
			kernelExec(runtime.store.Db, "UPDATE runtime SET active_task=?", task.taskId)
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
