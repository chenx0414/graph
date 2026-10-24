package graph

import (
	"encoding/json"
	"errors"
	"strings"
)

// QuestionOwner is who may answer a parked question.
type QuestionOwner string

const (
	QuestionOwnerUser QuestionOwner = "user"
	QuestionOwnerMain QuestionOwner = "main"
)

// ProblemAction is one action the settlement path can actually accept.
type ProblemAction string

const (
	ProblemActionRetry          ProblemAction = "retry"
	ProblemActionAcknowledge    ProblemAction = "acknowledge"
	ProblemActionRespond        ProblemAction = "respond"
	ProblemActionReconcileUsage ProblemAction = "reconcile_usage"
	ProblemActionEscalate       ProblemAction = "escalate"
)

// QuestionPolicy is the ownership, offered actions and answer acceptance of
// one question kind. Ownership, offered actions and answer acceptance share
// the same policy. Message retries are deliberately narrower than
// configuration recovery.
type QuestionPolicy struct {
	Owner          QuestionOwner
	Answers        []string
	RetryOnMessage bool
	Escalate       bool
}

// QuestionAutoAnswer is the answer a policy already approved.
type QuestionAutoAnswer struct {
	Answer       Answer
	PolicyDigest string
	Resume       *bool
}

// QuestionInput is one durable question to insert.
type QuestionInput struct {
	TaskId      string
	NodeId      string
	OperationId *string
	Kind        string
	Data        any
	AutoAnswer  *QuestionAutoAnswer
}

// QuestionInsertResult is the inserted question and the owner it went to.
type QuestionInsertResult struct {
	Id    string        `json:"id"`
	Owner QuestionOwner `json:"owner"`
}

// questionPolicies is the ownership table of every known question kind.
var questionPolicies = map[string]QuestionPolicy{
	"permission":           {Owner: QuestionOwnerUser, Answers: []string{"grant"}},
	"budget":               {Owner: QuestionOwnerUser, Answers: []string{"add_budget"}},
	"reservation_exceeded": {Owner: QuestionOwnerUser, Answers: []string{"acknowledge"}},
	"human_check":          {Owner: QuestionOwnerUser, Answers: []string{"acknowledge", "reject"}},
	"system_change":        {Owner: QuestionOwnerUser, Answers: []string{"respond"}},
	"unknown_usage":        {Owner: QuestionOwnerMain, Answers: []string{"usage", "reconcile_usage"}},
	"waiting":              {Owner: QuestionOwnerMain, Answers: []string{"respond"}},
	"adapter_error":        {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true},
	"execution_failed":     {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true, Escalate: true},
	"model_unavailable":    {Owner: QuestionOwnerMain, Answers: []string{"retry"}},
	"git_conflict":         {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true},
	"context_rejected":     {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true, Escalate: true},
	"recovery":             {Owner: QuestionOwnerMain, Answers: []string{"retry"}, RetryOnMessage: true},
	"result_noncompliant":  {Owner: QuestionOwnerMain, Answers: []string{"retry"}, Escalate: true},
	"git_dirty":            {Owner: QuestionOwnerMain, Answers: []string{"acknowledge"}},
	// A node stuck for three rounds or returned for rework may need a decision
	// only the user can make. Escalating hands the decision over with the main
	// Agent's own explanation attached instead of looping on a retry that
	// cannot change the outcome.
	"rework":  {Owner: QuestionOwnerMain, Answers: []string{"respond", "retry"}, Escalate: true},
	"stalled": {Owner: QuestionOwnerMain, Answers: []string{"respond", "retry"}, Escalate: true},
}

// questionMaster is the master node of one task.
type questionMaster struct {
	Id     string
	Status string
}

// questionPolicy reads the policy of one question kind.
func questionPolicy(kind string) QuestionPolicy {
	if rule, ok := questionPolicies[kind]; ok {
		return rule
	}
	return QuestionPolicy{Owner: QuestionOwnerMain, Answers: []string{}}
}

// ProblemActions only exposes actions that the settlement path can accept.
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

// AssertQuestionAnswer rejects an answer the open question does not accept.
// Value validation and settlement effects remain with OperationLifecycle.
func AssertQuestionAnswer(kind string, answer Answer) {
	if !containsString(questionPolicy(kind).Answers, answer.Type) {
		Raise("invalid_answer", "Answer type does not match the open question")
	}
}

// QuestionOwnerOf routes a question to its owner. Only decisions the user
// alone can make bypass the main Agent. Everything else is first routed to the
// main Agent for diagnosis and resolution.
func QuestionOwnerOf(kind string, data any) QuestionOwner {
	body := questionRecord(data)
	// A worker or the main Agent may hand a decision back to the user through a
	// waiting question; those request types are the user's to answer.
	// A master question of its own is the user's decision to make: it routes to
	// the inbox instead of becoming an internal problem nobody outside the
	// runtime can answer.
	if kind == "waiting" {
		switch body["requestType"] {
		case "model_access", "noncompliance_decision", "user_decision":
			return QuestionOwnerUser
		}
	}
	return questionPolicy(kind).Owner
}

// QuestionSummary is the one-line description of a parked question.
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

// IsMasterParked reports whether a pending master is parked. Callers must not
// infer readiness from status alone.
func IsMasterParked(store *TaskStore, taskId, nodeId string) bool {
	return kernelRow(store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open' AND owner='main' LIMIT 1", taskId, nodeId) != nil
}

// RecoverMaster releases a master for an explicit message or configuration
// change. Startup does not call this: simply reopening the runtime must leave
// problems parked. It reports whether a parked problem was resolved. Writes
// join an existing command/recovery transaction, or open one when called on
// its own.
func RecoverMaster(store *TaskStore, taskId, reason string) bool {
	apply := func() any {
		master := questionMasterNode(store, taskId)
		if master == nil {
			return false
		}
		parked := kernelRows(store.Db, "SELECT id,kind FROM questions WHERE task_id=? AND node_id=? AND status='open' AND owner='main'", taskId, master.Id)
		if reason == "configuration" {
			if len(parked) == 0 || kernelRow(store.Db, "SELECT id FROM questions WHERE task_id=? AND status='open' AND owner='user' LIMIT 1", taskId) != nil {
				return false
			}
		}
		released := []map[string]any{}
		if reason == "configuration" {
			released = parked
		} else {
			for _, question := range parked {
				if questionPolicy(kernelString(question["kind"])).RetryOnMessage {
					released = append(released, question)
				}
			}
		}
		for _, question := range released {
			store.ResolveQuestion(kernelString(question["id"]), map[string]any{"type": "retry"})
		}
		if reason == "configuration" || (master.Status != "preparing" && master.Status != "running" && master.Status != "blocked") {
			store.SetNodePending(taskId, master.Id)
		}
		if reason == "configuration" {
			store.Event(taskId, "task.master_recovered", map[string]any{"reason": "internal problem parked while the environment was unavailable"})
		}
		return len(released) > 0
	}
	if store.IsTransaction() {
		released, _ := apply().(bool)
		return released
	}
	released, _ := store.Transaction(apply).(bool)
	return released
}

// InsertQuestion inserts one durable question and routes it to the correct
// owner. Main-owned questions wake the conversation master; user-owned
// questions open the human wait ledger and become visible in the inbox.
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
	// A problem on the master node itself cannot be resolved by waking the same
	// master: it would immediately hit the identical failure again. It stays a
	// main-owned problem (invisible to the user) and is parked from the
	// scheduler until an explicit retry or configuration recovery releases it.
	selfOwned := master != nil && anchorTaskId == input.TaskId && master.Id == input.NodeId
	store.OpenQuestion(id, input.TaskId, input.NodeId, questionOptionalOperationId(input.OperationId), input.Kind, input.Data, owner)

	if input.AutoAnswer != nil {
		if input.Kind == "permission" && input.AutoAnswer.Answer.Type == "grant" {
			requested, ok := questionRecord(input.Data)["grant"].(string)
			if !ok || requested != input.AutoAnswer.Answer.Grant {
				panic(errors.New("Automatic grant must match the requested capability"))
			}
			kernelExec(store.Db, "INSERT OR IGNORE INTO task_grants VALUES(?,?)", input.TaskId, input.AutoAnswer.Answer.Grant)
		}
		store.ResolveQuestion(id, input.AutoAnswer.Answer)
		if input.AutoAnswer.Resume != nil && *input.AutoAnswer.Resume {
			store.SetNodePending(input.TaskId, input.NodeId)
			kernelExec(store.Db, "UPDATE activations SET state='pending' WHERE id=(SELECT activation_id FROM nodes WHERE task_id=? AND id=?)", input.TaskId, input.NodeId)
		}
		store.Event(input.TaskId, "question.auto_approved", map[string]any{
			"questionId":   id,
			"nodeId":       input.NodeId,
			"operationId":  questionOptionalOperationId(input.OperationId),
			"kind":         input.Kind,
			"answer":       input.AutoAnswer.Answer,
			"policyDigest": input.AutoAnswer.PolicyDigest,
		})
	} else if owner == QuestionOwnerMain && hasConversation && master != nil {
		routing := map[string]any{
			"questionId": id,
			"taskId":     input.TaskId,
			"nodeId":     input.NodeId,
			"kind":       input.Kind,
			"summary":    QuestionSummary(input.Kind, input.Data),
			"owner":      string(owner),
		}
		// The main Agent runs as the conversation master. Its prompt reads the
		// structured problem list; no user-visible raw error message is inserted.
		if master.Status != "preparing" && master.Status != "running" {
			store.SetNodePending(anchorTaskId, master.Id)
		}
		// Record the same durable, deduplicated intent every other wake uses, so a
		// problem that is observed again does not become a second turn. A problem
		// on the master's own node is parked instead: waking the master about
		// itself would hit the identical failure again, which is what "parked" has
		// always meant here.
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
		// A node that stopped because only a person can unblock it is still a fact
		// the conversation's master should hear about once: it is the actor
		// holding the context to say what this means and what happens next. The
		// wake is idempotent, so observing the same block again does not queue a
		// second turn.
		//
		// A question the master raised itself must not wake that same master: it
		// would start a turn whose only content is the question it just asked.
		if !selfOwned {
			if input.Kind == "human_check" {
				// Review-before-the-user: the master looks at the evidence first, so
				// a check that should never have been raised can be sent back
				// through rework instead of interrupting the person. Approving here
				// is deliberately not acceptance - see approveHumanCheck - because
				// acceptance stays the person's own decision.
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

// HumanCheckPreReview reads the evidence a human acceptance check is resting
// on, or nil when the question is not an open human check. This is what the
// master reads before deciding whether the person should be asked at all.
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

// PendingHumanChecks lists the open human checks of one conversation that are
// waiting for the master's look.
//
// Scoped by conversation, not by a task id, because the check belongs to
// whichever graph task raised it - a different task from the conversation's
// anchor.
//
// A check that has already been approved is not listed: the master reviewed
// it, and listing it again is how the same check gets reviewed twice.
func PendingHumanChecks(store *TaskStore, conversationId string) []map[string]any {
	rows := kernelRows(store.Db, `SELECT q.id,q.task_id,q.node_id,q.data FROM questions q
    JOIN tasks t ON t.id=q.task_id
    WHERE t.conversation_id=? AND q.kind='human_check' AND q.status='open' ORDER BY q.rowid`, conversationId)
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

// ApproveHumanCheck records the master's approval of a human check.
//
// Approving is **not** acceptance. The check stays open and stays the user's
// to answer, because acceptance is the person's own judgement and a machine
// that signs for them makes "human acceptance" a name for something it is
// not. What changes is that the master's look is now a durable, visible fact,
// so an unapproved check is one nobody has examined rather than one nobody
// mentioned.
//
// Idempotent: approving an already-approved check writes nothing and returns
// false, so a retried command cannot manufacture a second approval.
func ApproveHumanCheck(store *TaskStore, questionId, note string) bool {
	apply := func() any {
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
		approved, _ := apply().(bool)
		return approved
	}
	approved, _ := store.Transaction(apply).(bool)
	return approved
}

// questionMasterNode reads the master node of one task.
func questionMasterNode(store *TaskStore, taskId string) *questionMaster {
	row := kernelRow(store.Db, "SELECT id,status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master' LIMIT 1", taskId)
	if row == nil {
		return nil
	}
	return &questionMaster{Id: kernelString(row["id"]), Status: kernelString(row["status"])}
}

// questionConversationAnchor reads the conversation a task belongs to.
// TODO(port): conversation.ts owns conversationForTask. This reads the same
// row directly so the routing file does not depend on that translation's
// row type.
func questionConversationAnchor(store *TaskStore, taskId string) (string, bool) {
	row := kernelRow(store.Db, "SELECT c.anchor_task_id FROM conversations c JOIN tasks t ON t.conversation_id=c.id WHERE t.id=?", taskId)
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
