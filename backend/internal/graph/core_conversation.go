package graph

type ConversationRole string

const (
	ConversationGlobal  ConversationRole = "global"
	ConversationProject ConversationRole = "project"
	ConversationHistory ConversationRole = "history"
	ConversationLegacy  ConversationRole = "legacy"
)

// ConversationRow is one conversations table row.
type ConversationRow struct {
	Role               ConversationRole `json:"role"`
	Id                 string           `json:"id"`
	ProjectId          *string          `json:"project_id"`
	WorkspaceProjectId string           `json:"workspace_project_id"`
	AnchorTaskId       string           `json:"anchor_task_id"`
	Title              string           `json:"title"`
	CreatedSeq         int64            `json:"created_seq"`
	CreatedAt          int64            `json:"created_at"`
	ArchivedAt         *int64           `json:"archived_at"`
	ThinkingLevel      *string          `json:"thinking_level"`
	BindingSinceSeq    int64            `json:"binding_since_seq"`
}

// ConversationMessage is one durable transcript row.
type ConversationMessage struct {
	Id          string         `json:"id"`
	Seq         int            `json:"seq"`
	Role        string         `json:"role"`
	Kind        string         `json:"kind"`
	Text        string         `json:"text"`
	Data        map[string]any `json:"data"`
	State       string         `json:"state"`
	OperationId *string        `json:"operationId"`
	Turn        int            `json:"turn"`
	CreatedAt   int64          `json:"createdAt"`
	UpdatedAt   int64          `json:"updatedAt"`
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
	// MessageStateRunning is a tool call that is executing outside the turn
	// that dispatched it.
	//
	// It is deliberately not `pending`: the queue and the stuck-node check read
	// pending and queued as "somebody still has to act on this message", and a
	// background tool call is not a message waiting for a turn - it is work
	// whose outcome will arrive as one. A pending tool row would be picked up
	// as input, which is how a node wakes itself in a loop.
	MessageStateRunning   MessageState = "running"
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
// CacheUsedAt is the settled time (Unix milliseconds) of the same turn CacheReadTokens came
// from, so the console can say how long ago the cached prefix was last read. No provider
// reports a cache expiry instant, and this view does not invent one.
type ConversationMasterUsageView struct {
	CachedInput     int64  `json:"cachedInput"`
	CacheInput      int64  `json:"cacheInput"`
	ContextTokens   *int64 `json:"contextTokens"`
	CacheReadTokens *int64 `json:"cacheReadTokens"`
	CacheUsedAt     *int64 `json:"cacheUsedAt"`
	// Throughput describes the newest request that produced tokens: how many it
	// wrote and how long the provider took. TPS is derived from those two, never
	// from a guess about the machine - a provider that answers in 3s and writes
	// 400 tokens did 133 tokens/s on that request.
	OutputTokens    *int64   `json:"outputTokens"`
	LatencyMs       *int64   `json:"latencyMs"`
	TokensPerSecond *float64 `json:"tokensPerSecond"`
}

// RSI_RELOAD_RECEIPT is what a turn says when it committed a change and a reload is pending.
const RSI_RELOAD_RECEIPT = "RSI 改动已提交，等待重载。当前回合已结束；重载确认后会自动继续，并将报告更新为“已生效”。"

// RecordTurnRefusal tells the user that a master turn cannot start.
//
// A conversation whose master node does not exist has no turn to run: the
// message that asked for it would wait for a reply that cannot come. The
// message is kept - it was never delivered, so it still runs once a model can
// be called - and the reason is given in the same words a turn that never
// started uses. One notice per reason: a second one would only repeat the
// first.
func RecordTurnRefusal(store *TaskStore, conversationId string, reason string) {
	text := TurnFailureText(reason, TurnFailureSetup)
	if kernelRow(store.Db, "SELECT id FROM messages WHERE conversation_id=? AND role='system' AND kind='error' AND text=? LIMIT 1", conversationId, text) != nil {
		return
	}
	AppendMessage(store, MessageInput{
		ConversationID: conversationId,
		Role:           MessageRoleSystem,
		Kind:           "error",
		Text:           text,
		State:          MessageStateDone,
	})
}
