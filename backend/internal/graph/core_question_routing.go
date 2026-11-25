package graph

import (
	"errors"
	"strings"

	"encoding/json"
)

type QuestionOwner string

const (
	QuestionOwnerUser QuestionOwner = "user"
	QuestionOwnerMain QuestionOwner = "main"
)

type ProblemAction string

const (
	ProblemActionRetry          ProblemAction = "retry"
	ProblemActionAcknowledge    ProblemAction = "acknowledge"
	ProblemActionRespond        ProblemAction = "respond"
	ProblemActionReconcileUsage ProblemAction = "reconcile_usage"
	ProblemActionEscalate       ProblemAction = "escalate"
)

type QuestionPolicy struct {
	Owner          QuestionOwner
	Answers        []string
	RetryOnMessage bool
	Escalate       bool
}

type QuestionAutoAnswer struct {
	Answer       Answer
	PolicyDigest string
	Resume       *bool
}

type QuestionInput struct {
	TaskId      string
	NodeId      string
	OperationId *string
	Kind        string
	Data        any
	AutoAnswer  *QuestionAutoAnswer
}

type QuestionInsertResult struct {
	Id    string        `json:"id"`
	Owner QuestionOwner `json:"owner"`
}

var questionPolicies = map[string]QuestionPolicy{
	"permission":           {Owner: QuestionOwnerUser, Answers: []string{"grant"}},
	"budget":               {Owner: QuestionOwnerUser, Answers: []string{"add_budget"}},
	"reservation_exceeded": {Owner: QuestionOwnerUser, Answers: []string{"acknowledge"}},
	"human_check":          {Owner: QuestionOwnerUser, Answers: []string{"acknowledge", "reject"}},
	"system_change":        {Owner: QuestionOwnerUser, Answers: []string{"respond"}},
	"credential":           {Owner: QuestionOwnerUser, Answers: []string{"respond"}},
	"unknown_usage":        {Owner: QuestionOwnerMain, Answers: []string{"usage", "reconcile_usage"}},
	"waiting":              {Owner: QuestionOwnerMain, Answers: []string{"respond"}},
	"adapter_error":        {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true},
	"execution_failed":     {Owner: QuestionOwnerMain, Answers: []string{"retry", "wait", "pause"}, RetryOnMessage: true, Escalate: true},
	"model_unavailable":    {Owner: QuestionOwnerMain, Answers: []string{"retry"}},
	"git_conflict":         {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true},
	"context_rejected":     {Owner: QuestionOwnerMain, Answers: []string{"retry", "wait", "pause"}, RetryOnMessage: true, Escalate: true},
	"recovery":             {Owner: QuestionOwnerMain, Answers: []string{"retry", "acknowledge"}, RetryOnMessage: true, Escalate: true},
	"result_noncompliant":  {Owner: QuestionOwnerMain, Answers: []string{"retry", "wait", "pause"}, Escalate: true},
	"git_dirty":            {Owner: QuestionOwnerMain, Answers: []string{"acknowledge"}},
	"rework":               {Owner: QuestionOwnerMain, Answers: []string{"respond", "retry", "wait", "pause"}, Escalate: true},
	"stalled":              {Owner: QuestionOwnerMain, Answers: []string{"respond", "retry", "wait", "pause"}, Escalate: true},
}

type questionMaster struct {
	Id     string
	Status string
}

func questionPolicy(kind string) QuestionPolicy {
	if rule, ok := questionPolicies[kind]; ok {
		return rule
	}
	return QuestionPolicy{Owner: QuestionOwnerMain, Answers: []string{}}
}

func ProblemActions(kind string) []ProblemAction {
	rule := questionPolicy(kind)
	if rule.Owner != QuestionOwnerMain {
		return []ProblemAction{}
	}
	actions := []ProblemAction{}
	for _, answer := range rule.Answers {
		switch answer {
		case "retry", "respond", "acknowledge", "reconcile_usage":
			actions = append(actions, ProblemAction(answer))
		}
	}
	if rule.Escalate {
		actions = append(actions, ProblemActionEscalate)
	}
	return actions
}

func AssertQuestionAnswer(kind string, answer Answer) {
	if !containsString(questionPolicy(kind).Answers, answer.Type) {
		Raise("invalid_answer", "Answer type does not match the open question")
	}
}

func QuestionOwnerOf(kind string, data any) QuestionOwner {
	body := questionRecord(data)
	if kind == "waiting" {
		switch body["requestType"] {
		case "model_access", "noncompliance_decision", "user_decision":
			return QuestionOwnerUser
		}
	}
	return questionPolicy(kind).Owner
}

func QuestionSummary(kind string, data any) string {
	body := questionRecord(data)
	for _, key := range []string{"prompt", "reason", "message", "grant", "requested"} {
		value, ok := body[key].(string)
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		trimmed := []rune(strings.TrimSpace(value))
		if len(trimmed) > 500 {
			trimmed = trimmed[:500]
		}
		return string(trimmed)
	}
	return "执行问题：" + kind
}

func IsMasterParked(store *TaskStore, taskId, nodeId string) bool {
	for _, row := range kernelRows(store.Db, "SELECT kind FROM questions WHERE task_id=? AND node_id=? AND status='open'", taskId, nodeId) {
		if questionPolicy(kernelString(row["kind"])).Owner == QuestionOwnerMain {
			return true
		}
	}
	return false
}

func InsertQuestion(store *TaskStore, input QuestionInput) QuestionInsertResult {
	id := graphUUID()
	preferred := QuestionOwnerOf(input.Kind, input.Data)
	anchorTaskId, hasConversation := questionConversationAnchor(store, input.TaskId)
	var master *questionMaster
	if hasConversation {
		master = questionMasterNode(store, anchorTaskId)
	}
	owner := QuestionOwnerUser
	if preferred == QuestionOwnerMain && master != nil {
		owner = QuestionOwnerMain
	}
	selfOwned := master != nil && anchorTaskId == input.TaskId && master.Id == input.NodeId
	store.OpenQuestion(id, input.TaskId, input.NodeId, questionOptionalOperationId(input.OperationId), input.Kind, input.Data, owner)
	routeGlobal := false
	if input.Kind == "waiting" && questionRecord(input.Data)["requestType"] == "supervisor_decision" {
		conversation := ConversationForTask(store, input.TaskId)
		if conversation == nil || conversation.Role != ConversationProject || conversation.AnchorTaskId != input.TaskId || !selfOwned {
			Raise("permission", "Only a project supervisor can ask the global supervisor")
		}
		global := kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE role='global' AND archived_at IS NULL")
		if global == nil {
			Raise("invalid_state", "The global supervisor is unavailable")
		}
		store.RouteQuestion(id, "global")
		routeGlobal = true
		WakeMaster(store, WakeIntent{TaskID: kernelString(global["anchor_task_id"]), Kind: "supervisor_question", DedupeKey: id,
			Data: map[string]any{"questionId": id, "revision": 1, "projectId": conversation.ProjectId}, HasData: true})
	}
	if questionPolicy(input.Kind).Escalate && selfOwned {
		conversation := ConversationForTask(store, input.TaskId)
		global := kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE role='global' AND archived_at IS NULL")
		if conversation != nil && conversation.Role == ConversationProject && global != nil {
			store.RouteQuestion(id, "global")
			routeGlobal = true
			WakeMaster(store, WakeIntent{TaskID: kernelString(global["anchor_task_id"]), Kind: "supervisor_question", DedupeKey: id,
				Data: map[string]any{"questionId": id, "revision": 1, "projectId": conversation.ProjectId}, HasData: true})
		}
	}

	if input.AutoAnswer != nil {
		if input.Kind == "permission" && input.AutoAnswer.Answer.Type == "grant" {
			requested, ok := questionRecord(input.Data)["grant"].(string)
			if !ok || requested != input.AutoAnswer.Answer.Grant {
				panic(errors.New("Automatic grant must match the requested capability"))
			}
			store.GrantTaskCapability(input.TaskId, input.AutoAnswer.Answer.Grant)
		}
		store.ResolveQuestion(id, input.AutoAnswer.Answer)
		if input.AutoAnswer.Resume != nil && *input.AutoAnswer.Resume {
			store.SetNodePending(input.TaskId, input.NodeId)
			store.ResetNodeActivation(input.TaskId, input.NodeId)
		}
		store.Event(input.TaskId, "question.auto_approved", map[string]any{
			"questionId":   id,
			"nodeId":       input.NodeId,
			"operationId":  questionOptionalOperationId(input.OperationId),
			"kind":         input.Kind,
			"answer":       input.AutoAnswer.Answer,
			"policyDigest": input.AutoAnswer.PolicyDigest,
		})
	} else if routeGlobal {
		store.Event(input.TaskId, "problem.routed_global", map[string]any{"questionId": id, "revision": 1})
	} else if owner == QuestionOwnerMain && hasConversation && master != nil {
		routing := map[string]any{
			"questionId": id,
			"taskId":     input.TaskId,
			"nodeId":     input.NodeId,
			"kind":       input.Kind,
			"summary":    QuestionSummary(input.Kind, input.Data),
			"owner":      string(owner),
		}
		if master.Status != "preparing" && master.Status != "running" {
			store.SetNodePending(anchorTaskId, master.Id)
		}
		if !selfOwned {
			WakeForBlockedNode(store, input.TaskId, BlockedNodeWake{NodeID: input.NodeId, Reason: input.Kind})
		}
		eventType := "problem.routed"
		if selfOwned {
			eventType = "problem.parked"
		}
		store.Event(anchorTaskId, eventType, routing)
	} else {
		OpenUserWait(store, input.TaskId, input.NodeId)
		if !selfOwned {
			if input.Kind == "human_check" {
				WakeForHumanCheck(store, input.TaskId, map[string]any{"nodeId": input.NodeId, "questionId": id})
			} else {
				WakeForBlockedNode(store, input.TaskId, BlockedNodeWake{NodeID: input.NodeId, Reason: input.Kind})
			}
		}
	}

	if input.AutoAnswer == nil {
		store.Event(input.TaskId, "question.opened", map[string]any{
			"nodeId":      input.NodeId,
			"kind":        input.Kind,
			"data":        input.Data,
			"operationId": questionOptionalOperationId(input.OperationId),
			"questionId":  id,
			"owner":       string(owner),
		})
	}
	return QuestionInsertResult{Id: id, Owner: owner}
}

func HumanCheckPreReview(store *TaskStore, questionId string) map[string]any {
	row := kernelRow(store.Db, "SELECT id,task_id,node_id,kind,status,data FROM questions WHERE id=?", questionId)
	if row == nil || kernelString(row["kind"]) != "human_check" {
		return nil
	}
	data := questionParseRecord(kernelString(row["data"]))
	review := map[string]any{
		"questionId":   kernelString(row["id"]),
		"taskId":       kernelString(row["task_id"]),
		"nodeId":       kernelString(row["node_id"]),
		"status":       kernelString(row["status"]),
		"activationId": nil,
		"commitSha":    nil,
		"approved":     questionPreApproved(data),
	}
	if activationId, ok := data["activationId"].(string); ok {
		review["activationId"] = activationId
	}
	if commitSha, ok := data["commitSha"].(string); ok {
		review["commitSha"] = commitSha
	}
	return review
}

func PendingHumanChecks(store *TaskStore, conversationId string) []map[string]any {
	rows := kernelRows(store.Db, `SELECT q.id,q.task_id,q.node_id,q.data FROM questions q
    JOIN tasks t ON t.id=q.task_id
    LEFT JOIN kernel_graph_owners g ON g.task_id=t.id LEFT JOIN tasks owner ON owner.id=g.owner_task_id
    WHERE COALESCE(owner.conversation_id,t.conversation_id)=? AND q.kind='human_check' AND q.status='open' ORDER BY q.rowid`, conversationId)
	checks := []map[string]any{}
	for _, row := range rows {
		if questionPreApproved(questionParseRecord(kernelString(row["data"]))) {
			continue
		}
		checks = append(checks, map[string]any{
			"questionId": kernelString(row["id"]),
			"taskId":     kernelString(row["task_id"]),
			"nodeId":     kernelString(row["node_id"]),
		})
	}
	return checks
}

func ApproveHumanCheck(store *TaskStore, questionId, note string) bool {
	apply := func(tx *TaskStore) any {
		store := tx
		row := kernelRow(store.Db, "SELECT task_id,node_id,data FROM questions WHERE id=? AND kind='human_check' AND status='open'", questionId)
		if row == nil {
			return false
		}
		data := questionParseRecord(kernelString(row["data"]))
		if questionPreApproved(data) {
			return false
		}
		updated := map[string]any{}
		for key, value := range data {
			updated[key] = value
		}
		updated["preReview"] = map[string]any{"approved": true, "note": note}
		store.AmendQuestionData(questionId, updated)
		store.Event(kernelString(row["task_id"]), "human.prereview_approved", map[string]any{
			"questionId": questionId,
			"nodeId":     kernelString(row["node_id"]),
			"note":       note,
		})
		return true
	}
	if store.IsTransaction() {
		approved, _ := apply(store).(bool)
		return approved
	}
	approved, _ := store.Transaction(func(tx *TaskStore) any { return apply(tx) }).(bool)
	return approved
}

func questionMasterNode(store *TaskStore, taskId string) *questionMaster {
	row := kernelRow(store.Db, "SELECT id,status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master' LIMIT 1", taskId)
	if row == nil {
		return nil
	}
	return &questionMaster{Id: kernelString(row["id"]), Status: kernelString(row["status"])}
}

func questionConversationAnchor(store *TaskStore, taskId string) (string, bool) {
	row := kernelRow(store.Db, `SELECT c.anchor_task_id FROM tasks t
 LEFT JOIN kernel_graph_owners g ON g.task_id=t.id LEFT JOIN tasks owner ON owner.id=g.owner_task_id
 JOIN conversations c ON c.id=COALESCE(owner.conversation_id,t.conversation_id) WHERE t.id=?`, taskId)
	if row == nil {
		return "", false
	}
	return kernelString(row["anchor_task_id"]), true
}

func questionRecord(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil
	}
	return record
}

func questionPreApproved(data map[string]any) bool {
	review, ok := data["preReview"].(map[string]any)
	if !ok {
		return false
	}
	approved, ok := review["approved"].(bool)
	return ok && approved
}

func questionOptionalOperationId(operationId *string) any {
	if operationId == nil {
		return nil
	}
	return *operationId
}

func questionParseRecord(text string) map[string]any {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		panic(err)
	}
	return parsed
}
