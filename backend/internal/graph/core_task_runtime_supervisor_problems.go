package graph

import (
	"encoding/json"
	"strings"
	"time"
)

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

type TaskRuntimeTaskStatusInput struct {
	TaskId      *string
	NodeId      *string
	WaitForNode *string
	TimeoutMs   *int
}

func (supervisor *TaskRuntimeSupervisor) TaskStatus(input TaskRuntimeTaskStatusInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	target := supervisor.taskId
	if input.TaskId != nil {
		ownerTaskID, owned := runtime.kernel.GraphOwner(*input.TaskId)
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
	scope := "(q.task_id IN (" + placeholders + ") AND q.route_stage IS NULL)"
	if conversation.Role == ConversationProject && conversation.AnchorTaskId == supervisor.taskId {
		scope = "(q.task_id IN (" + placeholders + ") AND (q.route_stage IS NULL OR q.route_stage='project'))"
	}
	if conversation.Role == ConversationGlobal && conversation.AnchorTaskId == supervisor.taskId {
		scope += " OR q.route_stage='global'"
	}
	rows := kernelRows(runtime.store.Db, `SELECT q.id,q.task_id,q.node_id,q.kind,q.data,q.route_stage,q.route_revision,
      t.request,t.phase,n.status AS node_status,i.model
    FROM questions q JOIN tasks t ON t.id=q.task_id
    LEFT JOIN nodes n ON n.task_id=q.task_id AND n.id=q.node_id
    LEFT JOIN instances i ON i.id=n.instance_id
    WHERE q.owner='main' AND q.status='open' AND (`+scope+`)
    ORDER BY q.rowid`, params...)
	out := []map[string]any{}
	for _, row := range rows {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		actions := ProblemActions(kernelString(row["kind"]))
		if row["route_stage"] != nil && (kernelString(row["kind"]) == "waiting" || kernelString(row["kind"]) == "recovery") {
			actions = append(actions, ProblemActionEscalate)
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
			"allowedActions": actions,
			"routeStage":     row["route_stage"],
			"revision":       kernelInt(row["route_revision"]),
		})
	}
	return out
}

type TaskRuntimeResolveInput struct {
	QuestionId       string
	Action           string
	Response         *string
	Proof            *string
	RequestId        string
	ExpectedRevision *int64
}

func (supervisor *TaskRuntimeSupervisor) ResolveProblem(input TaskRuntimeResolveInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This master is not attached to a conversation")
	}
	tasks := runtime.conversationTaskIds(conversation.Id)
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tasks)), ",")
	params := []any{input.QuestionId}
	for _, id := range tasks {
		params = append(params, id)
	}
	scope := "(task_id IN (" + placeholders + ") AND route_stage IS NULL)"
	if conversation.Role == ConversationProject && conversation.AnchorTaskId == supervisor.taskId {
		scope = "(task_id IN (" + placeholders + ") AND (route_stage IS NULL OR route_stage='project'))"
	}
	if conversation.Role == ConversationGlobal && conversation.AnchorTaskId == supervisor.taskId {
		scope += " OR route_stage='global'"
	}
	receipt := runtime.store.Command("problems:"+supervisor.taskId, input.RequestId, input, func() any {
		row := kernelRow(runtime.store.Db, `SELECT id,task_id,node_id,kind,data,route_stage,route_revision
          FROM questions WHERE id=? AND owner='main' AND status='open' AND (`+scope+`)`, params...)
		if row == nil {
			settledParams := []any{input.QuestionId}
			for _, id := range tasks {
				settledParams = append(settledParams, id)
			}
			settled := kernelRow(runtime.store.Db, `SELECT id,task_id,answer FROM questions
          WHERE id=? AND owner='main' AND status='resolved' AND (`+scope+`)`, settledParams...)
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
		if row["route_stage"] != nil {
			if input.ExpectedRevision == nil || *input.ExpectedRevision != kernelInt(row["route_revision"]) {
				Raise("stale_question", "The question changed; read it again before resolving it")
			}
			returningToProject := kernelString(row["route_stage"]) == "global" && questionParseRecord(kernelString(row["data"]))["requestType"] == "node_decision"
			if input.Action != "escalate" && !returningToProject && !runtime.store.AdvanceQuestionRevision(input.QuestionId, kernelString(row["route_stage"]), *input.ExpectedRevision) {
				Raise("stale_question", "The question changed; read it again before resolving it")
			}
		}
		allowed := []string{}
		for _, action := range ProblemActions(kernelString(row["kind"])) {
			allowed = append(allowed, string(action))
		}
		if row["route_stage"] != nil && (kernelString(row["kind"]) == "waiting" || kernelString(row["kind"]) == "recovery") {
			allowed = append(allowed, "escalate")
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
			if row["route_stage"] != nil {
				if kernelString(row["route_stage"]) == "project" {
					runtime.escalateQuestionToGlobal(row, text)
					return map[string]any{"questionId": input.QuestionId, "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": false, "routeStage": "global"}
				}
				runtime.escalateRoutedQuestion(row, text)
				return map[string]any{"questionId": input.QuestionId, "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": false, "routeStage": "user"}
			}
			runtime.execution.Escalate(kernelString(row["task_id"]), kernelString(row["id"]), text)
			return map[string]any{"questionId": kernelString(row["id"]), "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": true}
		}
		answer := Answer{}
		switch input.Action {
		case "retry":
			if kernelString(row["kind"]) == "recovery" && row["route_stage"] != nil && (input.Proof == nil || strings.TrimSpace(*input.Proof) == "") {
				Raise("invalid_answer", "Explain the inspection that makes retry safe")
			}
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
		if kernelString(row["route_stage"]) == "global" && questionParseRecord(kernelString(row["data"]))["requestType"] == "node_decision" {
			if input.Action != "respond" {
				Raise("invalid_answer", "A node question requires a response or escalation")
			}
			runtime.returnNodeQuestionToProject(row, answer.Value.(string))
			return map[string]any{"questionId": input.QuestionId, "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": false, "routeStage": "project"}
		}
		if kernelString(row["route_stage"]) == "project" && questionParseRecord(kernelString(row["data"]))["requestType"] == "node_decision" {
			return runtime.answerProjectNodeQuestion(row, input.Action, answer)
		}
		runtime.execution.Answer(kernelString(row["task_id"]), kernelString(row["id"]), answer)
		if kernelString(row["kind"]) == "recovery" && row["route_stage"] != nil && input.Proof != nil {
			runtime.store.Event(kernelString(row["task_id"]), "problem.recovery_inspected", map[string]any{"questionId": input.QuestionId, "proof": strings.TrimSpace(*input.Proof)})
		}
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

type TaskRuntimeReviewInput struct {
	QuestionId string
	Approve    bool
	Note       string
	RequestId  string
}

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
