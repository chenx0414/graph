package graph

import (
	"fmt"
	"strings"

	"encoding/json"
)

// TurnFailureText turns an internal failure into a short, actionable line for the chat.
// Raw exception text, stack traces and JSON stay in the problem ledger.
func TurnFailureText(reason string, kind ...TurnFailureKind) string {
	failureKind := TurnFailureRun
	if len(kind) > 0 {
		failureKind = kind[0]
	}
	// A setup failure never reached the model, so its text is the environment story and has to be
	// shown. Reading a stack that merely mentions package_json_reader as a truncated model output
	// is how a Pi worker that could not load its own modules became an actively misleading notice.
	detail := failureDetail(reason)
	// A failure the transport already retried says so, with the original error
	// next to it. "Send it again" is what the user used to read after the daemon
	// had already spent two retries on their behalf: the message was never lost,
	// the endpoint was, and only the user's own resend ever produced a reply.
	if retries, retried := TransportRetries(reason); retried {
		return fmt.Sprintf("主 Agent 本轮没有完成回复：已自动重试 %d 次仍失败。", retries) + conversationFailureSuffix(detail)
	}
	if failureKind == TurnFailureSetup {
		return "主 Agent 本轮没有启动起来，回复没有完成。消息已保留，可以再发一次重试。" + conversationFailureSuffix(detail)
	}
	if conversationInterruptedPattern.MatchString(reason) {
		return "已打断当前模型思考和工具调用。"
	}
	if conversationTruncatedPattern.MatchString(reason) {
		return "主 Agent 本轮的模型输出被截断，回复没有完成。消息已保留，可以再发一次或切换模型后重试。"
	}
	if conversationUnknownUsagePattern.MatchString(reason) {
		return "主 Agent 本轮缺少可核对的用量，消息已保留，稍后可以重试。"
	}
	return "主 Agent 本轮没有完成回复，消息已保留，可以再发一次重试。" + conversationFailureSuffix(detail)
}

// turnFailureOutputKeys are the fields a failed turn carries its reason in.
//
// A run failure carries error, a setup failure carries setupError. Reading the
// field is what keeps a setup failure from being described as a truncated
// model output.
var turnFailureOutputKeys = []string{"error", "setupError"}

// TurnFailureReason reads the concrete reason behind a failed master turn plus the field it
// came from: a run failure carries error, a setup failure carries setupError, and anything
// else falls back to the raw result. Reading the field is what keeps a setup failure from
// being described as a truncated model output.
func TurnFailureReason(result OperationResult) TurnFailure {
	output, _ := result.Output.(map[string]any)
	for _, key := range turnFailureOutputKeys {
		if value, ok := output[key].(string); ok && strings.TrimSpace(value) != "" {
			failureKind := TurnFailureRun
			if key == "setupError" {
				failureKind = TurnFailureSetup
			}
			return TurnFailure{Reason: value, Kind: failureKind}
		}
	}
	reason := CanonicalJSON(result.Outcome)
	if result.Output != nil {
		reason = CanonicalJSON(result.Output)
	}
	return TurnFailure{Reason: reason, Kind: TurnFailureRun}
}

// OperationReplied reports whether one turn already recorded its final answer. The marker
// lives on the operation, so it cannot be confused with a user message that shares the
// operation id and the kind.
func OperationReplied(store *TaskStore, operationId *string) bool {
	if operationId == nil || *operationId == "" {
		return false
	}
	row := kernelRow(store.Db, "SELECT replied_at FROM operations WHERE id=?", *operationId)
	if row == nil {
		return false
	}
	value, ok := row["replied_at"]
	if !ok || value == nil {
		return false
	}
	// The row object is always truthy, so the marker itself has to be inspected.
	switch value.(type) {
	case int64, int, float64:
		return true
	}
	return false
}

// MarkOperationReplied marks one turn as answered. Callers write it in the same transaction
// as the reply, so the marker and the reply become durable together.
func MarkOperationReplied(store *TaskStore, operationId *string) {
	if operationId == nil || *operationId == "" {
		return
	}
	store.MarkOperationReplied(*operationId, NowMillis())
}

// RecordConversationOutput persists the durable side of one master turn: its assistant
// reply and the summarized tool activity. Idempotent per operation.
func RecordConversationOutput(store *TaskStore, operation Operation, result OperationResult) {
	if operation.Kind != "agent" {
		return
	}
	spec := conversationNodeSpec(store, operation.TaskId, operation.NodeId)
	if spec.Role == nil || *spec.Role != "master" {
		return
	}
	conversation := ConversationForTask(store, operation.TaskId)
	if conversation == nil {
		return
	}
	// The marker is an explicit fact about the turn: a user message carries the same
	// operation id and kind='chat', so a message query cannot be trusted to decide
	// whether this turn already answered.
	alreadyReplied := OperationReplied(store, &operation.Id)
	output, _ := result.Output.(map[string]any)
	if result.Outcome == "completed" {
		reply := ""
		if text, ok := output["text"].(string); ok {
			reply = strings.TrimSpace(text)
		}
		suggestedPrompt := ""
		if text, ok := output["suggestedPrompt"].(string); ok {
			suggestedPrompt = utf16Slice(strings.TrimSpace(text), 500)
		}
		// The turn's activity keeps its own order: the narration the Agent emitted
		// between tool calls and the tool calls themselves, written before the reply
		// so the transcript reads in the order it happened. Rewritten on a retry
		// instead of duplicated, and the final reply stays the idempotency marker.
		activity := output["activity"]
		if !conversationActivityIsArray(activity) {
			activity = output["toolActivity"]
		}
		records := ConversationActivityRecords(activity, reply)
		PersistConversationActivity(store, conversation.Id, operation.Id, operation.Attempt, records, nil)
		if reply != "" && !alreadyReplied {
			var data any
			if suggestedPrompt != "" {
				data = map[string]any{"suggestedPrompt": suggestedPrompt}
			}
			AppendMessage(store, MessageInput{
				ConversationID: conversation.Id,
				Role:           MessageRoleAssistant,
				Kind:           "chat",
				Text:           reply,
				State:          MessageStateDone,
				OperationID:    &operation.Id,
				Turn:           operation.Attempt,
				Data:           data,
			})
			MarkOperationReplied(store, &operation.Id)
		}
	} else if result.Outcome == "failed" && !alreadyReplied {
		failure := TurnFailureReason(result)
		AppendMessage(store, MessageInput{
			ConversationID: conversation.Id,
			Role:           MessageRoleSystem,
			Kind:           "error",
			Text:           TurnFailureText(failure.Reason, failure.Kind),
			State:          MessageStateDone,
			OperationID:    &operation.Id,
			Turn:           operation.Attempt,
		})
	}
}

// RecordConversationInterruption records one plain-language interruption for a master turn
// whose outcome is uncertain and which will therefore not reach RecordConversationOutput.
func RecordConversationInterruption(store *TaskStore, operation Operation, reason string, kind ...TurnFailureKind) {
	if operation.Kind != "agent" {
		return
	}
	spec := conversationNodeSpec(store, operation.TaskId, operation.NodeId)
	if spec.Role == nil || *spec.Role != "master" {
		return
	}
	conversation := ConversationForTask(store, operation.TaskId)
	if conversation == nil {
		return
	}
	// A turn that already delivered its reply was not lost, even if the process died
	// afterwards (a reload can close it right after the receipt became durable), so a
	// second notice would only contradict what the user read.
	if OperationReplied(store, &operation.Id) {
		return
	}
	if kernelRow(store.Db, "SELECT id FROM messages WHERE operation_id=? AND role='system' AND kind='error' LIMIT 1", operation.Id) != nil {
		return
	}
	AppendMessage(store, MessageInput{
		ConversationID: conversation.Id,
		Role:           MessageRoleSystem,
		Kind:           "error",
		Text:           TurnFailureText(reason, kind...),
		State:          MessageStateDone,
		OperationID:    &operation.Id,
		Turn:           operation.Attempt,
	})
}

// ReleaseMessages queues the messages of a refused send again; a pre-send refusal proves
// the model never saw the message. The state change is published so incremental caches
// catch up.
func ReleaseMessages(store *TaskStore, operationId string) {
	rows := MessagesForOperation(store, operationId)
	released := []MessageRow{}
	for _, row := range rows {
		if row.State == string(MessageStateDelivered) {
			released = append(released, row)
		}
	}
	if len(released) == 0 {
		return
	}
	store.ReleaseDeliveredMessages(operationId, NowMillis())
	for _, row := range released {
		PublishMessageUpdate(store, row.Id)
	}
}

// ListMessages pages through the message list without ever hiding the newest records: the
// default page is the latest window, `after` walks forward (incremental reads) and `before`
// walks backward (history).
func ListMessages(store *TaskStore, conversationId string, query MessageQuery) []ConversationMessage {
	pageSize := 200
	if query.Limit != nil && *query.Limit > 0 {
		pageSize = *query.Limit
		if pageSize > 500 {
			pageSize = 500
		}
	}
	var rows []map[string]any
	switch {
	case query.After != nil:
		rows = kernelRows(store.Db, "SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
			conversationId, *query.After, pageSize)
	case query.Before != nil:
		rows = kernelRows(store.Db, "SELECT * FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
			conversationId, *query.Before, pageSize)
		rows = conversationReverseRows(rows)
	default:
		rows = kernelRows(store.Db, "SELECT * FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?",
			conversationId, pageSize)
		rows = conversationReverseRows(rows)
	}
	messages := make([]ConversationMessage, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, PublicMessage(conversationMessageFromRow(row)))
	}
	return messages
}

// ConversationDigest is the compact, factual execution status handed to the master on
// every turn. It is a projection of recorded state, never a fabricated summary: questions,
// phases, commits and node states come straight from the ledger.
func ConversationDigest(store *TaskStore, conversationId string) string {
	kernel := NewKernelStore(store)
	conversation := ConversationRowOf(store, conversationId)
	anchor := store.Task(conversation.AnchorTaskId)
	master := kernelRow(store.Db, "SELECT n.id,n.status,n.output,i.used,i.budget,i.model FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'", anchor.ID)
	lines := []string{conversationProjectLine(store, conversation.ProjectId)}
	var proposal map[string]any
	if anchor.LatestProposal != 0 {
		proposal = kernelRow(store.Db, "SELECT version,requirement_version,draft_revision,spec FROM proposals WHERE task_id=? AND version=? AND archived_at IS NULL AND deleted_at IS NULL",
			anchor.ID, anchor.LatestProposal)
	}
	if proposal != nil {
		spec := struct {
			Summary *string `json:"summary"`
		}{}
		if err := json.Unmarshal([]byte(kernelString(proposal["spec"])), &spec); err != nil {
			panic(err)
		}
		stale := ""
		if kernelInt(proposal["requirement_version"]) != anchor.RequirementVersion {
			stale = " (stale: requirement changed)"
		}
		summary := "(no summary)"
		if spec.Summary != nil {
			summary = *spec.Summary
		}
		lines = append(lines, fmt.Sprintf("Draft: v%d (draftRevision %d) on requirement v%d%s — %s",
			kernelInt(proposal["version"]), kernelInt(proposal["draft_revision"]),
			kernelInt(proposal["requirement_version"]), stale, summary))
	} else {
		lines = append(lines, "Draft: none yet")
	}
	// Archived and deleted cards are not the current draft, but main must still know
	// they exist so it can restore or delete one by version when the user asks.
	cards := kernelRows(store.Db, "SELECT version,archived_at,draft_revision FROM proposals WHERE task_id=? AND deleted_at IS NULL ORDER BY version", anchor.ID)
	cardTexts := []string{}
	hasArchived := false
	for _, card := range cards {
		archived := card["archived_at"] != nil
		if archived {
			hasArchived = true
		}
		text := fmt.Sprintf("v%d", kernelInt(card["version"]))
		if archived {
			text += " (archived)"
		}
		text += fmt.Sprintf(" rev%d", kernelInt(card["draft_revision"]))
		cardTexts = append(cardTexts, text)
	}
	// A single archived card must be discoverable too: main sees "Draft: none yet"
	// otherwise and never learns the user can restore it.
	if len(cards) > 1 || hasArchived {
		lines = append(lines, "Draft cards: "+strings.Join(cardTexts, ", ")+" — archive_draft, restore_draft and delete_draft act on one version")
	}
	if master != nil {
		model := "unknown"
		if master["model"] != nil {
			model = kernelString(master["model"])
		}
		used := int64(0)
		if master["used"] != nil {
			used = kernelInt(master["used"])
		}
		budget := int64(0)
		if master["budget"] != nil {
			budget = kernelInt(master["budget"])
		}
		lines = append(lines, fmt.Sprintf("Master: %s, model %s, used %d/%d tokens (input+output+cache read; cache reads dominate repeated context)",
			kernelString(master["status"]), model, used, budget))
	}
	mainProblems := kernelRows(store.Db, `SELECT q.id,q.task_id,q.node_id,q.kind,q.data
    FROM questions q JOIN tasks t ON t.id=q.task_id
    WHERE q.owner='main' AND q.status='open' AND (t.id=? OR t.conversation_id=?)
    ORDER BY q.rowid`, anchor.ID, conversationId)
	if len(mainProblems) > 0 {
		lines = append(lines, "Problems awaiting main Agent:")
		for _, problem := range mainProblems {
			data := conversationParseJson(kernelString(problem["data"]))
			lines = append(lines, fmt.Sprintf("- %s · %s@%s on task %s: %s",
				kernelString(problem["id"]), kernelString(problem["kind"]), kernelString(problem["node_id"]),
				utf16Slice(kernelString(problem["task_id"]), 8),
				conversationQuestionSummary(kernelString(problem["kind"]), data)))
		}
	}
	tasks := kernelRows(store.Db, "SELECT id,phase,paused,request,integration_sha,accepted_proposal FROM tasks WHERE conversation_id=? AND phase!='chatting' ORDER BY created_seq", conversationId)
	if len(tasks) == 0 {
		lines = append(lines, "Feature tasks: none (nothing has been dispatched)")
	}
	for _, task := range tasks {
		taskId := kernelString(task["id"])
		questions := kernelRows(store.Db, "SELECT id,kind,node_id,owner,data FROM questions WHERE task_id=? AND status='open' ORDER BY rowid", taskId)
		native := kernel.LatestRevision(taskId)
		used := int64(0)
		budget := int64(0)
		reserved := int64(0)
		tokens := ""
		if native != nil {
			usage := kernelRow(store.Db, "SELECT COALESCE(SUM(used),0) AS used, COALESCE(SUM(reserved),0) AS reserved FROM kernel_node_state WHERE task_id=?", taskId)
			used = kernelInt(usage["used"])
			reserved = kernelInt(usage["reserved"])
			tokens = fmt.Sprintf("%d; reserved %d", used, reserved)
		} else {
			usage := kernelRow(store.Db, "SELECT COALESCE(SUM(i.used),0) AS used, COALESCE(SUM(i.budget),0) AS budget FROM instances i JOIN nodes n ON n.instance_id=i.id WHERE n.task_id=?", taskId)
			used = kernelInt(usage["used"])
			budget = kernelInt(usage["budget"])
			tokens = fmt.Sprintf("%d/%d", used, budget)
		}
		paused := ""
		if kernelInt(task["paused"]) != 0 {
			paused = ", paused"
		}
		commit := "none"
		if task["integration_sha"] != nil {
			commit = utf16Slice(kernelString(task["integration_sha"]), 10)
		}
		nodes := conversationNodeSummary(store, kernel, taskId)
		if nodes == "" {
			nodes = "none"
		}
		lines = append(lines, fmt.Sprintf("Feature task %s (%s%s): request \"%s\"; commit %s; tokens %s; nodes: %s",
			utf16Slice(taskId, 8), kernelString(task["phase"]), paused,
			utf16Slice(kernelString(task["request"]), 120), commit, tokens, nodes))
		userQuestions := []map[string]any{}
		internalQuestions := []map[string]any{}
		for _, question := range questions {
			switch kernelString(question["owner"]) {
			case "user":
				userQuestions = append(userQuestions, question)
			case "main":
				internalQuestions = append(internalQuestions, question)
			}
		}
		if len(userQuestions) > 0 {
			parts := []string{}
			for _, question := range userQuestions {
				parts = append(parts, fmt.Sprintf("%s@%s", kernelString(question["kind"]), kernelString(question["node_id"])))
			}
			lines = append(lines, "  questions awaiting user: "+strings.Join(parts, ", "))
		}
		if len(internalQuestions) > 0 {
			lines = append(lines, "  problems awaiting main Agent:")
			for _, question := range internalQuestions {
				data := conversationParseJson(kernelString(question["data"]))
				lines = append(lines, fmt.Sprintf("  - %s · %s@%s: %s",
					kernelString(question["id"]), kernelString(question["kind"]), kernelString(question["node_id"]),
					conversationQuestionSummary(kernelString(question["kind"]), data)))
			}
		}
		evidence := kernelRows(store.Db, "SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid", taskId)
		if len(evidence) > 0 {
			parts := []string{}
			for _, item := range evidence {
				valid := "invalid"
				if kernelInt(item["valid"]) != 0 {
					valid = "valid"
				}
				parts = append(parts, fmt.Sprintf("%s:%s", kernelString(item["acceptance_id"]), valid))
			}
			lines = append(lines, "  evidence: "+strings.Join(parts, ", "))
		}
	}
	return strings.Join(lines, "\n")
}
