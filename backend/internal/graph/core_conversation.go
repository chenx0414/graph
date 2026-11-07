package graph

type ConversationRole string

const (
	ConversationGlobal  ConversationRole = "global"
	ConversationProject ConversationRole = "project"
	ConversationHistory ConversationRole = "history"
	ConversationLegacy  ConversationRole = "legacy"
)

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

type ConversationStream struct {
	OperationId string `json:"operationId"`
	EntryId     string `json:"entryId"`
	PartId      string `json:"partId"`
	Ordinal     int    `json:"ordinal"`
	Text        string `json:"text"`
	Length      int    `json:"length"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type MessageRole string

const (
	MessageRoleUser      MessageRole = "user"
	MessageRoleAssistant MessageRole = "assistant"
	MessageRoleTool      MessageRole = "tool"
	MessageRoleSystem    MessageRole = "system"
	MessageRoleActivity  MessageRole = "activity"
)

type MessageState string

const (
	MessageStateRunning   MessageState = "running"
	MessageStatePending   MessageState = "pending"
	MessageStateQueued    MessageState = "queued"
	MessageStateDelivered MessageState = "delivered"
	MessageStateDone      MessageState = "done"
	MessageStateFailed    MessageState = "failed"
	MessageStateCancelled MessageState = "cancelled"
)

type TurnFailureKind string

const (
	TurnFailureSetup TurnFailureKind = "setup"
	TurnFailureRun   TurnFailureKind = "run"
)

type ConversationActivityKind string

const (
	ConversationActivityNarration ConversationActivityKind = "narration"
	ConversationActivityTool      ConversationActivityKind = "tool"
)

type ConversationActivityRecord struct {
	Kind    ConversationActivityKind `json:"kind"`
	Text    string                   `json:"text"`
	Data    map[string]any           `json:"data,omitempty"`
	Ordinal *int                     `json:"ordinal,omitempty"`
}

type MessageInput struct {
	ConversationID string
	Role           MessageRole
	Kind           string
	Text           string
	Data        Json
	State       MessageState
	OperationID *string
	Turn        int
	MessageID *string
}

type AppendedMessage struct {
	ConversationMessage
	Cursor *int64 `json:"cursor"`
}

type MessageQuery struct {
	After  *int `json:"after,omitempty"`
	Before *int `json:"before,omitempty"`
	Limit  *int `json:"limit,omitempty"`
}

type MessageCancellation struct {
	State     string `json:"state"`
	Cancelled bool   `json:"cancelled"`
	Changed   bool   `json:"changed"`
}

type TurnFailure struct {
	Reason string          `json:"reason"`
	Kind   TurnFailureKind `json:"kind"`
}

type ConversationMasterUsageView struct {
	CachedInput     int64  `json:"cachedInput"`
	CacheInput      int64  `json:"cacheInput"`
	ContextTokens   *int64 `json:"contextTokens"`
	CacheReadTokens *int64 `json:"cacheReadTokens"`
	CacheUsedAt     *int64 `json:"cacheUsedAt"`
	OutputTokens    *int64   `json:"outputTokens"`
	LatencyMs       *int64   `json:"latencyMs"`
	TokensPerSecond *float64 `json:"tokensPerSecond"`
}

const RSI_RELOAD_RECEIPT = "RSI 改动已提交，等待重载。当前回合已结束；重载确认后会自动继续，并将报告更新为“已生效”。"

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
