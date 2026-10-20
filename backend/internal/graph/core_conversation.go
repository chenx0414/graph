package graph

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
)

// ConversationRow is one conversations table row.
type ConversationRow struct {
	Id                 string  `json:"id"`
	ProjectId          *string `json:"project_id"`
	WorkspaceProjectId string  `json:"workspace_project_id"`
	AnchorTaskId       string  `json:"anchor_task_id"`
	Title              string  `json:"title"`
	CreatedSeq         int64   `json:"created_seq"`
	CreatedAt          int64   `json:"created_at"`
	ArchivedAt         *int64  `json:"archived_at"`
	ThinkingLevel      *string `json:"thinking_level"`
	BindingSinceSeq    int64   `json:"binding_since_seq"`
}

// MessageRow is one messages table row.
type MessageRow struct {
	Seq            int64   `json:"seq"`
	Id             string  `json:"id"`
	ConversationId string  `json:"conversation_id"`
	Role           string  `json:"role"`
	Kind           string  `json:"kind"`
	Text           string  `json:"text"`
	Data           *string `json:"data"`
	State          string  `json:"state"`
	OperationId    *string `json:"operation_id"`
	Turn           int64   `json:"turn"`
	CreatedAt      int64   `json:"created_at"`
	UpdatedAt      int64   `json:"updated_at"`
}

// ConversationStreamRow is one conversation_streams table row.
type ConversationStreamRow struct {
	OperationId    string `json:"operation_id"`
	ConversationId string `json:"conversation_id"`
	EntryId        string `json:"entry_id"`
	PartId         string `json:"part_id"`
	Ordinal        int64  `json:"ordinal"`
	Text           string `json:"text"`
	Length         int64  `json:"length"`
	UpdatedAt      int64  `json:"updated_at"`
}

// ConversationStream is one live text part of a running operation, as the API returns it.
type ConversationStream struct {
	OperationId string `json:"operationId"`
	EntryId     string `json:"entryId"`
	PartId      string `json:"partId"`
	Ordinal     int    `json:"ordinal"`
	Text        string `json:"text"`
	Length      int    `json:"length"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// MessageRole is the author of one message.
type MessageRole string

const (
	MessageRoleUser      MessageRole = "user"
	MessageRoleAssistant MessageRole = "assistant"
	MessageRoleTool      MessageRole = "tool"
	MessageRoleSystem    MessageRole = "system"
	MessageRoleActivity  MessageRole = "activity"
)

// MessageState is the queue state of one message.
type MessageState string

const (
	MessageStatePending   MessageState = "pending"
	MessageStateQueued    MessageState = "queued"
	MessageStateDelivered MessageState = "delivered"
	MessageStateDone      MessageState = "done"
	MessageStateFailed    MessageState = "failed"
	MessageStateCancelled MessageState = "cancelled"
)

// TurnFailureKind tells whether a turn failed before the model ran or during the run.
type TurnFailureKind string

const (
	TurnFailureSetup TurnFailureKind = "setup"
	TurnFailureRun   TurnFailureKind = "run"
)

// ConversationActivityKind is the kind of one ordered activity record.
type ConversationActivityKind string

const (
	ConversationActivityNarration ConversationActivityKind = "narration"
	ConversationActivityTool      ConversationActivityKind = "tool"
)

// ConversationActivityRecord is one ordered record of a master turn's activity:
// the narration the Agent emitted between tool calls, and the tool calls themselves.
type ConversationActivityRecord struct {
	Kind    ConversationActivityKind `json:"kind"`
	Text    string                   `json:"text"`
	Data    map[string]any           `json:"data,omitempty"`
	Ordinal *int                     `json:"ordinal,omitempty"`
}

// MessageInput is one appendable or finalizable message.
type MessageInput struct {
	ConversationID string
	Role           MessageRole
	Kind           string
	Text           string
	// Data is the optional JSON payload. A nil Data stores SQL NULL, the way an
	// absent `data` did in TypeScript.
	Data        Json
	State       MessageState
	OperationID *string
	Turn        int
	// MessageID finalizes an existing row instead of inserting a new one.
	MessageID *string
}

// AppendedMessage is the public message plus the event cursor it produced.
type AppendedMessage struct {
	ConversationMessage
	Cursor *int64 `json:"cursor"`
}

// MessageQuery pages through the message list without hiding the newest records.
type MessageQuery struct {
	After  *int `json:"after,omitempty"`
	Before *int `json:"before,omitempty"`
	Limit  *int `json:"limit,omitempty"`
}

// MessageCancellation is the result of cancelling one queued message.
type MessageCancellation struct {
	State     string `json:"state"`
	Cancelled bool   `json:"cancelled"`
	Changed   bool   `json:"changed"`
}

// TurnFailure is the concrete reason behind a failed master turn.
type TurnFailure struct {
	Reason string          `json:"reason"`
	Kind   TurnFailureKind `json:"kind"`
}

// ConversationMasterUsageView is the cache and context counters of the master agent.
type ConversationMasterUsageView struct {
	CachedInput   int64  `json:"cachedInput"`
	CacheInput    int64  `json:"cacheInput"`
	ContextTokens *int64 `json:"contextTokens"`
}

// RSI_RELOAD_RECEIPT is what a turn says when it committed a change and a reload is pending.
const RSI_RELOAD_RECEIPT = "RSI 改动已提交，等待重载。当前回合已结束；重载确认后会自动继续，并将报告更新为“已生效”。"

// ConversationRowOf reads one conversation. The type name ConversationRow belongs to
// the row type, so the lookup carries the Of suffix the package uses elsewhere.
func ConversationRowOf(store *TaskStore, conversationId string) ConversationRow {
	row := kernelRow(store.Db, "SELECT * FROM conversations WHERE id=?", conversationId)
	if row == nil {
		Raise("not_found", "Conversation not found")
	}
	return ConversationRow{
		Id:                 kernelString(row["id"]),
		ProjectId:          conversationNullableString(row["project_id"]),
		WorkspaceProjectId: kernelString(row["workspace_project_id"]),
		AnchorTaskId:       kernelString(row["anchor_task_id"]),
		Title:              kernelString(row["title"]),
		CreatedSeq:         kernelInt(row["created_seq"]),
		CreatedAt:          kernelInt(row["created_at"]),
		ArchivedAt:         conversationNullableInt(row["archived_at"]),
		ThinkingLevel:      conversationNullableString(row["thinking_level"]),
		BindingSinceSeq:    kernelInt(row["binding_since_seq"]),
	}
}

// ConversationForTask reads the conversation one task belongs to, or nil when it has none.
func ConversationForTask(store *TaskStore, taskId string) *ConversationRow {
	row := kernelRow(store.Db, "SELECT c.* FROM conversations c JOIN tasks t ON t.conversation_id=c.id WHERE t.id=?", taskId)
	if row == nil {
		return nil
	}
	return &ConversationRow{
		Id:                 kernelString(row["id"]),
		ProjectId:          conversationNullableString(row["project_id"]),
		WorkspaceProjectId: kernelString(row["workspace_project_id"]),
		AnchorTaskId:       kernelString(row["anchor_task_id"]),
		Title:              kernelString(row["title"]),
		CreatedSeq:         kernelInt(row["created_seq"]),
		CreatedAt:          kernelInt(row["created_at"]),
		ArchivedAt:         conversationNullableInt(row["archived_at"]),
		ThinkingLevel:      conversationNullableString(row["thinking_level"]),
		BindingSinceSeq:    kernelInt(row["binding_since_seq"]),
	}
}

// PublicMessage is the client projection of one message row. The ledger keeps the full
// attachment payload, but the client projection never carries image base64: only
// name/type/size leave the process.
func PublicMessage(row MessageRow) ConversationMessage {
	message := ConversationMessage{
		Id:          row.Id,
		Seq:         int(row.Seq),
		Role:        row.Role,
		Kind:        row.Kind,
		Text:        row.Text,
		State:       row.State,
		OperationId: row.OperationId,
		Turn:        int(row.Turn),
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
	}
	if row.Data != nil && *row.Data != "" {
		var parsed any
		if err := json.Unmarshal([]byte(*row.Data), &parsed); err != nil {
			panic(err)
		}
		if record, ok := StripAttachmentData(parsed).(map[string]any); ok {
			message.Data = record
		}
	}
	return message
}

// PublishConversationDelta persists one appendable live response, publishing only the new
// suffix in the common case. A reset carries the full active text so a reconnect can
// repair any missing prefix without guessing.
func PublishConversationDelta(store *TaskStore, input PiAdapterConversationDelta) {
	previous := kernelRow(store.Db, "SELECT * FROM conversation_streams WHERE operation_id=? AND entry_id=? AND part_id=?",
		input.OperationId, input.EntryId, input.PartId)
	appendable := false
	if previous != nil {
		// The caller writes the length of a text part in the same unit the
		// TypeScript string length used, so the delta is counted the same way.
		appendable = strings.HasPrefix(input.Text, kernelString(previous["text"])) &&
			int(kernelInt(previous["length"]))+utf16Len(input.Delta) == input.Length
	}
	reset := !appendable
	text := input.Text
	if !reset {
		text = input.Delta
	}
	store.Transaction(func() any {
		kernelExec(store.Db, `INSERT INTO conversation_streams(
      operation_id,conversation_id,entry_id,part_id,ordinal,text,length,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(operation_id,entry_id,part_id) DO UPDATE SET
      conversation_id=excluded.conversation_id,
      ordinal=excluded.ordinal,
      text=excluded.text,
      length=excluded.length,
      updated_at=excluded.updated_at`,
			input.OperationId, input.ConversationId, input.EntryId, input.PartId,
			input.Ordinal, input.Text, input.Length, NowMillis())
		store.Event(input.TaskId, "message.delta", map[string]any{
			"operationId": input.OperationId,
			"entryId":     input.EntryId,
			"partId":      input.PartId,
			"ordinal":     input.Ordinal,
			"text":        text,
			"len":         input.Length,
			"reset":       reset,
		})
		return nil
	})
}

// ClearConversationStream drops the live text parts of one operation.
func ClearConversationStream(store *TaskStore, operationId string) {
	kernelExec(store.Db, "DELETE FROM conversation_streams WHERE operation_id=?", operationId)
}

// ConversationStreams lists the live text parts of the operations that are still running.
func ConversationStreams(store *TaskStore, conversationId string) []ConversationStream {
	rows := kernelRows(store.Db, `SELECT s.* FROM conversation_streams s
    JOIN operations o ON o.id=s.operation_id
    WHERE s.conversation_id=? AND o.state IN ('intent','dispatched')
    ORDER BY s.ordinal, s.updated_at`, conversationId)
	streams := make([]ConversationStream, 0, len(rows))
	for _, row := range rows {
		streams = append(streams, ConversationStream{
			OperationId: kernelString(row["operation_id"]),
			EntryId:     kernelString(row["entry_id"]),
			PartId:      kernelString(row["part_id"]),
			Ordinal:     int(kernelInt(row["ordinal"])),
			Text:        kernelString(row["text"]),
			Length:      int(kernelInt(row["length"])),
			UpdatedAt:   kernelInt(row["updated_at"]),
		})
	}
	return streams
}

// ConversationActivityRecords decides the ordered, deduplicated activity records of one
// completed master turn. The final reply is written separately, so a narration whose text
// is the reply itself is dropped instead of appearing twice. Older operations carry only
// tool activity, without a `type`. Pure, so the rule is testable without a store.
func ConversationActivityRecords(activity any, reply string) []ConversationActivityRecord {
	records := []ConversationActivityRecord{}
	for _, item := range conversationActivityItems(activity) {
		entry, ok := conversationActivityEntry(item)
		if !ok {
			continue
		}
		// The ordinal is the shared order of the turn's text parts and tool calls; the
		// transcript needs it to keep a steering message where it interrupted.
		ordinal := conversationActivityOrdinal(entry["ordinal"])
		if conversationActivityString(entry["type"]) == string(ConversationActivityNarration) {
			text := strings.TrimSpace(conversationActivityString(entry["text"]))
			if text == "" || text == reply {
				continue
			}
			record := ConversationActivityRecord{Kind: ConversationActivityNarration, Text: text}
			if ordinal != nil {
				record.Ordinal = ordinal
			}
			records = append(records, record)
			continue
		}
		summary := conversationActivityString(entry["summary"])
		if strings.TrimSpace(summary) == "" {
			continue
		}
		data := map[string]any{}
		text := summary
		if name, ok := entry["name"].(string); ok {
			data["tool"] = name
			text = name + ": " + summary
		} else {
			data["tool"] = "tool"
		}
		if toolCallId, ok := entry["toolCallId"].(string); ok {
			data["toolCallId"] = toolCallId
		}
		if conversationActivityString(entry["state"]) == "error" {
			data["error"] = true
		}
		record := ConversationActivityRecord{Kind: ConversationActivityTool, Text: text, Data: data}
		if ordinal != nil {
			record.Ordinal = ordinal
		}
		records = append(records, record)
	}
	return records
}

// PersistConversationActivity checkpoints completed narration and tool calls before a
// reload can stop the worker. Ordinals identify records across the checkpoint and final
// settlement.
func PersistConversationActivity(store *TaskStore, conversationId, operationId string, turn int,
	records []ConversationActivityRecord, activeToolIds map[string]bool) {
	type activityRow struct {
		id    string
		data  string
		text  string
		state string
	}
	existing := kernelRows(store.Db, "SELECT id,data,text,state FROM messages WHERE operation_id=? AND role IN ('activity','tool')", operationId)
	byKey := map[string]activityRow{}
	for _, row := range existing {
		data := kernelString(row["data"])
		// BUG(port): a row without an activity key stringifies to "undefined", so every
		// such row shares one map slot. The TypeScript did the same.
		key := "undefined"
		if data != "" {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(data), &parsed); err == nil {
				if value, ok := parsed["activityKey"]; ok {
					key = conversationActivityStringify(value)
				}
			}
		}
		byKey[key] = activityRow{
			id:    kernelString(row["id"]),
			data:  data,
			text:  kernelString(row["text"]),
			state: kernelString(row["state"]),
		}
	}
	for index, record := range records {
		key := conversationActivityKey(record, index)
		previous, hasPrevious := byKey[key]
		previousData := map[string]any{}
		if hasPrevious && previous.data != "" {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(previous.data), &parsed); err == nil && parsed != nil {
				previousData = parsed
			}
		}
		data := map[string]any{}
		if record.Kind == ConversationActivityTool {
			for name, value := range record.Data {
				data[name] = value
			}
		}
		data["activityKey"] = key
		if record.Ordinal != nil {
			data["ordinal"] = *record.Ordinal
		}
		if record.Kind == ConversationActivityTool {
			if attachments, ok := previousData["attachments"].([]any); ok {
				data["attachments"] = attachments
			}
		}
		state := string(MessageStateDone)
		if record.Kind == ConversationActivityTool {
			if toolCallId, ok := record.Data["toolCallId"].(string); ok && activeToolIds[toolCallId] {
				state = string(MessageStatePending)
			}
		}
		if hasPrevious && previous.text == record.Text && previous.state == state &&
			previous.data == CanonicalJSON(data) {
			continue
		}
		var messageId *string
		if hasPrevious {
			id := previous.id
			messageId = &id
		}
		role := MessageRoleTool
		kind := "tool"
		if record.Kind == ConversationActivityNarration {
			role = MessageRoleActivity
			kind = "activity"
		}
		AppendMessage(store, MessageInput{
			ConversationID: conversationId,
			OperationID:    &operationId,
			Turn:           turn,
			Role:           role,
			Kind:           kind,
			Text:           record.Text,
			Data:           data,
			State:          MessageState(state),
			MessageID:      messageId,
		})
	}
}

// AppendMessage appends one durable message and publishes it on the conversation stream.
func AppendMessage(store *TaskStore, input MessageInput) AppendedMessage {
	now := NowMillis()
	operationId := ""
	if input.OperationID != nil {
		operationId = *input.OperationID
	}
	if operationId != "" && input.Role == MessageRoleAssistant {
		ClearConversationStream(store, operationId)
	}
	state := string(input.State)
	if state == "" {
		state = string(MessageStateDone)
	}
	var data any
	if input.Data != nil {
		data = CanonicalJSON(input.Data)
	}
	if input.MessageID != nil && *input.MessageID != "" {
		kernelExec(store.Db, "UPDATE messages SET text=?,data=?,state=?,operation_id=?,turn=?,updated_at=MAX(?,updated_at+1) WHERE id=? AND conversation_id=?",
			input.Text, data, state, input.OperationID, input.Turn, now, *input.MessageID, input.ConversationID)
		row, ok := conversationMessageRow(store, *input.MessageID)
		if !ok {
			Raise("not_found", "Message not found")
		}
		anchor := ConversationRowOf(store, input.ConversationID).AnchorTaskId
		store.Event(anchor, "message.updated", map[string]any{"message": PublicMessage(row)})
		return AppendedMessage{ConversationMessage: PublicMessage(row)}
	}
	id := newUUID()
	kernelExec(store.Db, "INSERT INTO messages(conversation_id,id,role,kind,text,data,state,operation_id,turn,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
		input.ConversationID, id, string(input.Role), input.Kind, input.Text, data, state, input.OperationID, input.Turn, now, now)
	row, ok := conversationMessageRow(store, id)
	if !ok {
		Raise("not_found", "Message not found")
	}
	anchor := ConversationRowOf(store, input.ConversationID).AnchorTaskId
	cursor := store.Event(anchor, "message.created", map[string]any{"message": PublicMessage(row)})
	return AppendedMessage{ConversationMessage: PublicMessage(row), Cursor: &cursor}
}

// PendingMessages lists the messages the next master turn must answer.
func PendingMessages(store *TaskStore, conversationId string, limit int) []MessageRow {
	if limit <= 0 {
		limit = 50
	}
	rows := kernelRows(store.Db, "SELECT * FROM messages WHERE conversation_id=? AND state IN ('pending','queued') ORDER BY seq LIMIT ?", conversationId, limit)
	return conversationMessageRows(rows)
}

// DeliverMessages moves accepted queued messages to the current end of the stream before
// marking them delivered. This keeps a queued turn after the assistant reply that
// preceded it instead of reusing the timestamp at which the user typed.
func DeliverMessages(store *TaskStore, operationId string, turn int, messages []MessageRow, ordinal ...int) {
	// A delivered message can carry the ordinal of the turn it joined, so a steering
	// message keeps the place it interrupted in the transcript.
	hasOrdinal := len(ordinal) > 0
	for _, message := range messages {
		var rowData any
		if hasOrdinal {
			rowData = conversationOrdinalData(message, ordinal[0])
		}
		if message.State == string(MessageStateQueued) {
			next := int(kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages")["seq"]))
			kernelExec(store.Db, `UPDATE messages SET seq=?,state='delivered',operation_id=?,turn=?,data=COALESCE(?,data),updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='queued'`, next, operationId, turn, rowData, NowMillis(), message.Id)
			kernelExec(store.Db, "UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='messages'", next)
		} else {
			kernelExec(store.Db, `UPDATE messages SET state='delivered',operation_id=?,turn=?,data=COALESCE(?,data),updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='pending'`, operationId, turn, rowData, NowMillis(), message.Id)
		}
		PublishMessageUpdate(store, message.Id)
	}
}

// MessagesForOperation lists the messages bound to one operation, used by failure paths
// to requeue or report.
func MessagesForOperation(store *TaskStore, operationId string) []MessageRow {
	rows := kernelRows(store.Db, "SELECT * FROM messages WHERE operation_id=? ORDER BY seq", operationId)
	return conversationMessageRows(rows)
}

// PublishMessageUpdate publishes one durable message record on the conversation stream.
func PublishMessageUpdate(store *TaskStore, messageId string) {
	row, ok := conversationMessageRow(store, messageId)
	if !ok {
		return
	}
	anchor := ConversationRowOf(store, row.ConversationId).AnchorTaskId
	store.Event(anchor, "message.updated", map[string]any{"message": PublicMessage(row)})
}

// CancelQueuedMessage cancels one message that is still waiting in the conversation queue.
// Only a message that belongs to this conversation and is still `queued` can be cancelled:
// a delivered message and the running turn are never touched, and a message that was
// already cancelled stays cancelled without a new event. The state change is published so
// every viewer drops the row from its queue.
func CancelQueuedMessage(store *TaskStore, conversationId, messageId string) MessageCancellation {
	row := kernelRow(store.Db, "SELECT conversation_id,state FROM messages WHERE id=?", messageId)
	if row == nil || kernelString(row["conversation_id"]) != conversationId {
		return MessageCancellation{State: "missing"}
	}
	state := kernelString(row["state"])
	if state != string(MessageStateQueued) {
		return MessageCancellation{State: state, Cancelled: state == string(MessageStateCancelled)}
	}
	changes := kernelChanges(store.Db, "UPDATE messages SET state='cancelled',updated_at=MAX(?,updated_at+1) WHERE id=? AND state='queued'",
		NowMillis(), messageId)
	if changes > 0 {
		PublishMessageUpdate(store, messageId)
	}
	current := kernelRow(store.Db, "SELECT state FROM messages WHERE id=?", messageId)
	currentState := ""
	if current != nil {
		currentState = kernelString(current["state"])
	}
	return MessageCancellation{
		State:     currentState,
		Cancelled: currentState == string(MessageStateCancelled),
		Changed:   changes > 0,
	}
}

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

// TurnFailureReason reads the concrete reason behind a failed master turn plus the field it
// came from: a run failure carries error, a setup failure carries setupError, and anything
// else falls back to the raw result. Reading the field is what keeps a setup failure from
// being described as a truncated model output.
func TurnFailureReason(result OperationResult) TurnFailure {
	output, _ := result.Output.(map[string]any)
	for _, key := range []string{"error", "setupError"} {
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
	kernelExec(store.Db, "UPDATE operations SET replied_at=COALESCE(replied_at,?) WHERE id=?", NowMillis(), *operationId)
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
	kernelExec(store.Db, "UPDATE messages SET state='pending',operation_id=NULL,updated_at=MAX(?,updated_at+1) WHERE operation_id=? AND state='delivered'",
		NowMillis(), operationId)
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
		lines = append(lines, fmt.Sprintf("Master: %s, model %s, used %d/%d tokens",
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

// NewConversationId mints the id of one new conversation.
func NewConversationId() string {
	return newUUID()
}

// ConversationMasterUsage rebuilds the master Agent's context and cache counters from the
// persisted invocation ledger. Invocations are joined through their operation's task, not
// through an instance id, so a replaced or rebound master instance can never drop the
// numbers back to zero: the records still belong to this conversation. `contextTokens` is
// the newest completed turn's `input+cacheRead+cacheWrite`; a completion whose usage is
// missing or adds up to zero (a turn that never really ran) is not a completed turn and
// must not overwrite a known value. The cache aggregate uses the same denominator over every
// recorded turn.
func ConversationMasterUsage(store *TaskStore, conversationId string) ConversationMasterUsageView {
	rows := kernelRows(store.Db, `SELECT i.usage AS usage,i.purpose AS purpose
    FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN tasks t ON t.id=o.task_id
    WHERE t.conversation_id=?
      AND EXISTS (SELECT 1 FROM nodes n WHERE n.task_id=o.task_id AND n.id=o.node_id AND json_extract(n.spec,'$.role')='master')
    ORDER BY i.rowid`, conversationId)
	var cacheInput int64
	var cachedInput int64
	var contextTokens *int64
	for _, row := range rows {
		text := kernelString(row["usage"])
		if text == "" {
			continue
		}
		usage := struct {
			Input      *int64 `json:"input"`
			CacheRead  *int64 `json:"cacheRead"`
			CacheWrite *int64 `json:"cacheWrite"`
		}{}
		if err := json.Unmarshal([]byte(text), &usage); err != nil {
			panic(err)
		}
		input := int64(0)
		if usage.Input != nil {
			input = *usage.Input
		}
		cacheRead := int64(0)
		if usage.CacheRead != nil {
			cacheRead = *usage.CacheRead
		}
		cacheWrite := int64(0)
		if usage.CacheWrite != nil {
			cacheWrite = *usage.CacheWrite
		}
		total := input + cacheRead + cacheWrite
		cacheInput += total
		cachedInput += cacheRead
		if kernelString(row["purpose"]) == "completion" && total > 0 {
			value := total
			contextTokens = &value
		}
	}
	return ConversationMasterUsageView{CachedInput: cachedInput, CacheInput: cacheInput, ContextTokens: contextTokens}
}

var (
	conversationInterruptedPattern  = regexp.MustCompile(`(?i)打断|中断|interrupted`)
	conversationTruncatedPattern    = regexp.MustCompile(`(?i)unterminated string|unexpected end of (json|input)|unexpected token|output token limit|truncat`)
	conversationUnknownUsagePattern = regexp.MustCompile(`(?i)unknown usage`)
)

// failureDetail is the one line worth showing from a failure blob: its longest early line
// carries the message while stack frames stay short. Single line, bounded.
func failureDetail(reason string) string {
	lines := []string{}
	for _, part := range strings.Split(reason, "\n") {
		line := strings.Join(strings.Fields(part), " ")
		if line == "" {
			continue
		}
		lines = append(lines, line)
		if len(lines) == 8 {
			break
		}
	}
	best := ""
	for _, line := range lines {
		if utf16Len(line) > utf16Len(best) {
			best = line
		}
	}
	return utf16Slice(best, 240)
}

// conversationFailureSuffix renders the optional reason of a failed turn.
func conversationFailureSuffix(detail string) string {
	if detail == "" {
		return ""
	}
	return " 原因：" + detail
}

// conversationProjectLine describes the project a conversation is bound to.
func conversationProjectLine(store *TaskStore, projectId *string) string {
	if projectId == nil || *projectId == "" {
		return "Project: not bound (ask the user to choose one from the configured projects)"
	}
	row := kernelRow(store.Db, "SELECT root FROM projects WHERE id=?", *projectId)
	if row == nil {
		return "Project: " + *projectId
	}
	return "Project: " + *projectId + " (root " + kernelString(row["root"]) + ")"
}

// conversationQuestionSummary is the one short line that answers "what is this problem".
func conversationQuestionSummary(kind string, data any) string {
	body, _ := data.(map[string]any)
	for _, key := range []string{"prompt", "reason", "message", "grant", "requested"} {
		if value, ok := body[key].(string); ok && strings.TrimSpace(value) != "" {
			return utf16Slice(strings.TrimSpace(value), 500)
		}
	}
	return "执行问题：" + kind
}

// conversationNodeSummary lists the nodes of one task and their status.
func conversationNodeSummary(store *TaskStore, kernel *KernelStore, taskId string) string {
	if kernel.LatestRevision(taskId) != nil {
		nodes := kernel.ListNodes(taskId)
		parts := []string{}
		for _, node := range nodes {
			parts = append(parts, node.NodeId+":"+node.Status)
		}
		return strings.Join(parts, ", ")
	}
	rows := kernelRows(store.Db, "SELECT id,spec,status FROM nodes WHERE task_id=? ORDER BY rowid", taskId)
	parts := []string{}
	for _, row := range rows {
		parts = append(parts, kernelString(row["id"])+":"+kernelString(row["status"]))
	}
	return strings.Join(parts, ", ")
}

// conversationNodeSpec reads the spec of one node.
func conversationNodeSpec(store *TaskStore, taskId, nodeId string) NodeSpec {
	row := kernelRow(store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "No node for this operation")
	}
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	return spec
}

// conversationMessageRow reads one message row.
func conversationMessageRow(store *TaskStore, id string) (MessageRow, bool) {
	row := kernelRow(store.Db, "SELECT * FROM messages WHERE id=?", id)
	if row == nil {
		return MessageRow{}, false
	}
	return conversationMessageFromRow(row), true
}

// conversationMessageRows maps message rows.
func conversationMessageRows(rows []map[string]any) []MessageRow {
	messages := make([]MessageRow, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, conversationMessageFromRow(row))
	}
	return messages
}

// conversationMessageFromRow maps one messages table row.
func conversationMessageFromRow(row map[string]any) MessageRow {
	return MessageRow{
		Seq:            kernelInt(row["seq"]),
		Id:             kernelString(row["id"]),
		ConversationId: kernelString(row["conversation_id"]),
		Role:           kernelString(row["role"]),
		Kind:           kernelString(row["kind"]),
		Text:           kernelString(row["text"]),
		Data:           conversationNullableString(row["data"]),
		State:          kernelString(row["state"]),
		OperationId:    conversationNullableString(row["operation_id"]),
		Turn:           kernelInt(row["turn"]),
		CreatedAt:      kernelInt(row["created_at"]),
		UpdatedAt:      kernelInt(row["updated_at"]),
	}
}

// conversationReverseRows reverses a page read backwards.
func conversationReverseRows(rows []map[string]any) []map[string]any {
	reversed := make([]map[string]any, 0, len(rows))
	for index := len(rows) - 1; index >= 0; index-- {
		reversed = append(reversed, rows[index])
	}
	return reversed
}

// conversationNullableString reads a nullable text column.
func conversationNullableString(value any) *string {
	switch typed := value.(type) {
	case string:
		return &typed
	case []byte:
		text := string(typed)
		return &text
	default:
		return nil
	}
}

// conversationNullableInt reads a nullable integer column.
func conversationNullableInt(value any) *int64 {
	switch typed := value.(type) {
	case int64:
		return &typed
	case int:
		number := int64(typed)
		return &number
	case float64:
		number := int64(typed)
		return &number
	default:
		return nil
	}
}

// conversationParseJson reads one stored JSON payload.
func conversationParseJson(text string) any {
	if text == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		panic(err)
	}
	return value
}

// conversationOrdinalData renders the payload a delivered message carries when the turn it
// joined has an ordinal.
//
// BUG(port): the TypeScript helper this mirrors (messageData) read the raw `data` column,
// which stores a JSON string, and then asked whether that value was an object. A string never
// is, so the helper always answered null and the delivered row kept only its ordinal: the
// earlier payload of the message was never merged back in. The TypeScript behaves the same
// way, so the port reproduces that instead of the intent behind it.
func conversationOrdinalData(message MessageRow, ordinal int) string {
	return `{"ordinal":` + itoa(ordinal) + `}`
}

// conversationActivityKey is the identity of one activity record inside a turn.
func conversationActivityKey(record ConversationActivityRecord, index int) string {
	if record.Kind == ConversationActivityTool {
		if value, ok := record.Data["toolCallId"]; ok && value != nil {
			return "tool:" + conversationActivityStringify(value)
		}
		if record.Ordinal != nil {
			return "tool:" + itoa(*record.Ordinal)
		}
		return "tool:" + itoa(index)
	}
	if record.Ordinal != nil {
		return "text:" + itoa(*record.Ordinal)
	}
	return "text:" + itoa(index)
}

// conversationActivityItems reads the entries of one activity list.
func conversationActivityItems(activity any) []any {
	if activity == nil {
		return nil
	}
	if items, ok := activity.([]any); ok {
		return items
	}
	value := reflect.ValueOf(activity)
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Slice && value.Kind() != reflect.Array {
		return nil
	}
	items := make([]any, 0, value.Len())
	for index := 0; index < value.Len(); index++ {
		items = append(items, value.Index(index).Interface())
	}
	return items
}

// conversationActivityIsArray reports whether one value is a list.
func conversationActivityIsArray(value any) bool {
	if value == nil {
		return false
	}
	if _, ok := value.([]any); ok {
		return true
	}
	reflected := reflect.ValueOf(value)
	return reflected.Kind() == reflect.Slice || reflected.Kind() == reflect.Array
}

// conversationActivityEntry reads one activity entry as a loose record.
func conversationActivityEntry(item any) (map[string]any, bool) {
	if item == nil {
		return nil, false
	}
	if record, ok := item.(map[string]any); ok {
		return record, true
	}
	value := reflect.ValueOf(item)
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil, false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return nil, false
	}
	record := map[string]any{}
	structType := value.Type()
	for index := 0; index < structType.NumField(); index++ {
		field := structType.Field(index)
		if field.PkgPath != "" {
			continue
		}
		name := field.Name
		if tag, ok := field.Tag.Lookup("json"); ok {
			tagName := strings.Split(tag, ",")[0]
			if tagName == "-" {
				continue
			}
			if tagName != "" {
				name = tagName
			}
		}
		record[name] = value.Field(index).Interface()
	}
	return record, true
}

// conversationActivityOrdinal reads the optional ordinal of one activity entry.
func conversationActivityOrdinal(value any) *int {
	switch typed := value.(type) {
	case int:
		ordinal := typed
		return &ordinal
	case int64:
		ordinal := int(typed)
		return &ordinal
	case float64:
		ordinal := int(typed)
		return &ordinal
	default:
		return nil
	}
}

// conversationActivityString reads one activity field as text.
func conversationActivityString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

// conversationActivityStringify renders one activity field the way String() did.
func conversationActivityStringify(value any) string {
	switch typed := value.(type) {
	case nil:
		return "undefined"
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case int:
		return itoa(typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case float64:
		return strings.TrimSuffix(fmt.Sprintf("%v", typed), ".0")
	default:
		return fmt.Sprintf("%v", typed)
	}
}
