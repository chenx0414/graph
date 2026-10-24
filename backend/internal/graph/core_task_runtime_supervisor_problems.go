package graph

import (
	"encoding/json"
	"strings"
	"time"
)

// GraphState reads the graph projection the main Agent sees.
func (supervisor *TaskRuntimeSupervisor) GraphState() map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	task := runtime.store.Task(supervisor.taskId)
	view := runtime.User().Task(supervisor.taskId).View()
	native := KernelGraphView(runtime.kernel, supervisor.taskId)
	state := map[string]any{
		"taskId":                  supervisor.taskId,
		"conversationId":          task.ConversationID,
		"projectId":               task.ProjectID,
		"request":                 task.Request,
		"phase":                   task.Phase,
		"status":                  view["status"],
		"paused":                  view["paused"],
		"requirementVersion":      task.RequirementVersion,
		"proposalVersion":         task.LatestProposal,
		"acceptedProposalVersion": task.AcceptedProposal,
		"graphVersion":            view["graphVersion"],
		"targetBranch":            task.TargetBranch,
		"integrationSha":          task.IntegrationSha,
		"nodes":                   view["nodes"],
		"evidence":                view["evidence"],
		"questions":               view["questions"],
		"worktrees":               view["worktrees"],
		"cost":                    view["cost"],
	}
	if native != nil {
		state["graph"] = native
		state["modules"] = native
	}
	return state
}

// TaskRuntimeTaskStatusInput is one status query of the main Agent.
type TaskRuntimeTaskStatusInput struct {
	TaskId      *string
	NodeId      *string
	WaitForNode *string
	TimeoutMs   *int
}

// TaskStatus reads the compact status projection of one task.
func (supervisor *TaskRuntimeSupervisor) TaskStatus(input TaskRuntimeTaskStatusInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	ownerTaskID, owned := runtime.kernel.GraphOwner(*input.TaskId)
	target := supervisor.taskId
	if input.TaskId != nil {
		if owned && ownerTaskID == supervisor.taskId {
			target = *input.TaskId
		} else {
			target = taskRuntimeConversationTarget(runtime.store, supervisor.taskId, input.TaskId, "A status query")
		}
	}
	view := taskRuntimeStatusView(runtime.store, runtime.kernel, target, input.NodeId)
	if input.WaitForNode == nil {
		return view
	}
	timeout := 120_000
	if input.TimeoutMs != nil {
		timeout = *input.TimeoutMs
	}
	if timeout < 0 {
		timeout = 0
	}
	if timeout > 600_000 {
		timeout = 600_000
	}
	started := NowMillis()
	known := map[string]bool{}
	for _, entry := range view["questions"].([]map[string]any) {
		known[entry["id"].(string)] = true
	}
	for _, entry := range view["problems"].([]map[string]any) {
		known[entry["id"].(string)] = true
	}
	current := view
	reason := "timeout"
	for {
		found := false
		for _, node := range current["nodes"].([]map[string]any) {
			if node["id"] == *input.WaitForNode {
				found = true
			}
		}
		if !found {
			taskRuntimeMissingTaskNode(runtime.kernel, target, *input.WaitForNode)
		}
		changed := false
		for _, entry := range current["questions"].([]map[string]any) {
			if !known[entry["id"].(string)] {
				changed = true
			}
		}
		for _, entry := range current["problems"].([]map[string]any) {
			if !known[entry["id"].(string)] {
				changed = true
			}
		}
		if changed {
			reason = "needs_you"
			break
		}
		settled := true
		for _, node := range current["nodes"].([]map[string]any) {
			if node["id"] != *input.WaitForNode {
				continue
			}
			status, _ := node["status"].(string)
			if status == "pending" || status == "running" {
				settled = false
			}
		}
		if runtime.kernel.LatestRevision(target) != nil {
			queued := kernelRow(runtime.store.Db, "SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state IN ('queued','claimed') LIMIT 1", target, *input.WaitForNode)
			if queued != nil {
				settled = false
			}
		}
		if settled {
			reason = "settled"
			break
		}
		if NowMillis()-started >= int64(timeout) {
			reason = "timeout"
			break
		}
		time.Sleep(time.Second)
		current = taskRuntimeStatusView(runtime.store, runtime.kernel, target, input.NodeId)
	}
	current["waitedMs"] = NowMillis() - started
	current["reason"] = reason
	return current
}

// ListProblems reads the main-owned problems of one conversation.
func (supervisor *TaskRuntimeSupervisor) ListProblems() []map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		return []map[string]any{}
	}
	tasks := runtime.conversationTaskIds(conversation.Id)
	if len(tasks) == 0 {
		return []map[string]any{}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tasks)), ",")
	params := []any{}
	for _, id := range tasks {
		params = append(params, id)
	}
	rows := kernelRows(runtime.store.Db, `SELECT q.id,q.task_id,q.node_id,q.kind,q.data,
      t.request,t.phase,n.status AS node_status,i.model
    FROM questions q JOIN tasks t ON t.id=q.task_id
    LEFT JOIN nodes n ON n.task_id=q.task_id AND n.id=q.node_id
    LEFT JOIN instances i ON i.id=n.instance_id
    WHERE q.owner='main' AND q.status='open' AND q.task_id IN (`+placeholders+`)
    ORDER BY q.rowid`, params...)
	out := []map[string]any{}
	for _, row := range rows {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		out = append(out, map[string]any{
			"id":             kernelString(row["id"]),
			"taskId":         kernelString(row["task_id"]),
			"nodeId":         kernelString(row["node_id"]),
			"kind":           kernelString(row["kind"]),
			"summary":        QuestionSummary(kernelString(row["kind"]), data),
			"data":           data,
			"taskRequest":    kernelString(row["request"]),
			"taskPhase":      kernelString(row["phase"]),
			"nodeStatus":     row["node_status"],
			"model":          row["model"],
			"allowedActions": ProblemActions(kernelString(row["kind"])),
		})
	}
	return out
}

// TaskRuntimeResolveInput resolves one main-owned problem.
type TaskRuntimeResolveInput struct {
	QuestionId string
	Action     string
	Response   *string
	Proof      *string
	RequestId  string
}

// ResolveProblem answers one main-owned problem.
func (supervisor *TaskRuntimeSupervisor) ResolveProblem(input TaskRuntimeResolveInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This master is not attached to a conversation")
	}
	tasks := runtime.conversationTaskIds(conversation.Id)
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tasks)), ",")
	params := []any{}
	for _, id := range tasks {
		params = append(params, id)
	}
	params = append(params, input.QuestionId)
	for _, id := range tasks {
		params = append(params, id)
	}
	receipt := runtime.store.Command("problems:"+supervisor.taskId, input.RequestId, input, func() any {
		row := kernelRow(runtime.store.Db, `SELECT id,task_id,node_id,kind,data
          FROM questions WHERE id=? AND owner='main' AND status='open' AND task_id IN (`+placeholders+`)`, params...)
		if row == nil {
			settledParams := []any{input.QuestionId}
			for _, id := range tasks {
				settledParams = append(settledParams, id)
			}
			settled := kernelRow(runtime.store.Db, `SELECT id,task_id,answer FROM questions
          WHERE id=? AND owner='main' AND status='resolved' AND task_id IN (`+placeholders+`)`, settledParams...)
			if settled == nil {
				Raise("not_found", "No open main-Agent problem with that id")
			}
			return map[string]any{
				"questionId":      kernelString(settled["id"]),
				"taskId":          kernelString(settled["task_id"]),
				"action":          input.Action,
				"resolved":        true,
				"alreadyResolved": true,
				"answer":          settled["answer"],
			}
		}
		allowed := []string{}
		for _, action := range ProblemActions(kernelString(row["kind"])) {
			allowed = append(allowed, string(action))
		}
		if !containsString(allowed, input.Action) {
			Raise("invalid_answer", "Problem "+kernelString(row["kind"])+" does not accept "+input.Action)
		}
		if input.Action == "escalate" {
			if input.Response == nil || strings.TrimSpace(*input.Response) == "" {
				Raise("invalid_answer", "An explanation is required to escalate a problem to the user")
			}
			text := strings.TrimSpace(*input.Response)
			if len([]rune(text)) > 4000 {
				text = string([]rune(text)[:4000])
			}
			runtime.execution.Escalate(kernelString(row["task_id"]), kernelString(row["id"]), text)
			return map[string]any{"questionId": kernelString(row["id"]), "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": true}
		}
		answer := Answer{}
		switch input.Action {
		case "retry":
			answer = Answer{Type: "retry"}
		case "acknowledge":
			answer = Answer{Type: "acknowledge"}
		case "respond":
			if input.Response == nil || strings.TrimSpace(*input.Response) == "" {
				Raise("invalid_answer", "A response is required")
			}
			text := strings.TrimSpace(*input.Response)
			if len([]rune(text)) > 4000 {
				text = string([]rune(text)[:4000])
			}
			answer = Answer{Type: "respond", Value: text}
		default:
			if input.Proof == nil || strings.TrimSpace(*input.Proof) == "" {
				Raise("invalid_answer", "A reconciliation rationale is required")
			}
			text := strings.TrimSpace(*input.Proof)
			if len([]rune(text)) > 4000 {
				text = string([]rune(text)[:4000])
			}
			answer = Answer{Type: "reconcile_usage", Proof: text}
		}
		runtime.execution.Answer(kernelString(row["task_id"]), kernelString(row["id"]), answer)
		runtime.store.Event(kernelString(row["task_id"]), "problem.resolved", map[string]any{
			"questionId": kernelString(row["id"]),
			"nodeId":     kernelString(row["node_id"]),
			"kind":       kernelString(row["kind"]),
			"action":     input.Action,
		})
		return map[string]any{"questionId": kernelString(row["id"]), "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": true}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	record, _ := jsonRecord(receipt)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// PendingHumanChecks reads the open human acceptance checks of one conversation.
func (supervisor *TaskRuntimeSupervisor) PendingHumanChecks() []any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		return []any{}
	}
	out := []any{}
	for _, check := range PendingHumanChecks(runtime.store, conversation.Id) {
		out = append(out, check)
	}
	return out
}

// TaskRuntimeReviewInput reviews one human acceptance check.
type TaskRuntimeReviewInput struct {
	QuestionId string
	Approve    bool
	Note       string
	RequestId  string
}

// ReviewHumanCheck approves or sends back one human acceptance check.
func (supervisor *TaskRuntimeSupervisor) ReviewHumanCheck(input TaskRuntimeReviewInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This master is not attached to a conversation")
	}
	inConversation := false
	for _, check := range PendingHumanChecks(runtime.store, conversation.Id) {
		record, _ := jsonRecord(check)
		if record != nil && record["questionId"] == input.QuestionId {
			inConversation = true
		}
	}
	if !inConversation {
		Raise("not_found", "No open human acceptance check with that id in this conversation")
	}
	result := runtime.store.Command("human-review:"+supervisor.taskId, input.RequestId, input, func() any {
		if input.Approve {
			return map[string]any{"questionId": input.QuestionId, "approved": ApproveHumanCheck(runtime.store, input.QuestionId, input.Note)}
		}
		check := HumanCheckPreReview(runtime.store, input.QuestionId)
		record, _ := jsonRecord(check)
		if record == nil || record["status"] != "open" {
			Raise("not_found", "That human acceptance check is not open")
		}
		taskId, _ := record["taskId"].(string)
		nodeId, _ := record["nodeId"].(string)
		InsertQuestion(runtime.store, QuestionInput{
			TaskId: taskId,
			NodeId: nodeId,
			Kind:   "rework",
			Data: map[string]any{
				"prompt":   "The main Agent reviewed the human acceptance check and sent it back",
				"reason":   input.Note,
				"rejected": true,
			},
		})
		runtime.store.ResolveQuestion(input.QuestionId, map[string]any{"type": "reject", "reason": input.Note})
		return map[string]any{"questionId": input.QuestionId, "approved": false, "sentBack": true}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// ListProjects reads the projects of the runtime.
func (supervisor *TaskRuntimeSupervisor) ListProjects() []map[string]any {
	return supervisor.runtime.User().Projects()
}

// BindProject binds the conversation of the supervisor to a project.
func (supervisor *TaskRuntimeSupervisor) BindProject(projectId, requestId string) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This Main Agent is not attached to a conversation")
	}
	return runtime.Conversations().Bind(conversation.Id, projectId, requestId)
}

// ConfirmDraft confirms one draft on behalf of the user.
func (supervisor *TaskRuntimeSupervisor) ConfirmDraft(input TaskRuntimeConfirmInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	if strings.TrimSpace(input.AttestationInstruction()) == "" {
		Raise("invalid_input", "An instruction is required: record the words that authorised this confirmation")
	}
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to confirm")
	}
	return runtime.Conversations().Confirm(*conversation, input)
}

// AttestationInstruction reads the recorded instruction of a confirmation.
func (input TaskRuntimeConfirmInput) AttestationInstruction() string {
	if input.Attestation == nil {
		return ""
	}
	return input.Attestation.Instruction
}

// ArchiveDraft archives one draft of the conversation of the supervisor.
func (supervisor *TaskRuntimeSupervisor) ArchiveDraft(input TaskRuntimeDraftInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to archive a draft in")
	}
	return runtime.Conversations().ArchiveDraft(*conversation, input)
}

// RestoreDraft restores one draft of the conversation of the supervisor.
func (supervisor *TaskRuntimeSupervisor) RestoreDraft(input TaskRuntimeDraftInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to restore a draft in")
	}
	return runtime.Conversations().RestoreDraft(*conversation, input)
}

// DeleteDraft deletes one draft of the conversation of the supervisor.
func (supervisor *TaskRuntimeSupervisor) DeleteDraft(input TaskRuntimeDraftInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to delete a draft from")
	}
	return runtime.Conversations().DeleteDraft(*conversation, input)
}
