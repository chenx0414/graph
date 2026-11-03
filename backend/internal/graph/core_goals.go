package graph

import (
	"strconv"
	"strings"
)

// A goal is a persistent objective one conversation keeps working toward.
//
// Measured 2026-11-03 (Codex /goal): the objective lives outside the chat as
// one row per thread with a status and a completion note, so a turn can end
// while the work continues. The same separation applies here: a `/goal` line is
// a command, not a message the model has to interpret.
//
// A goal has no budget. What stops it is the model saying the objective is done
// or genuinely blocked, the provider refusing the turn for capacity reasons, or
// the person pausing, clearing or replacing the objective. A numeric cap on how
// many turns a goal may run is exactly what this file does not contain: the
// brake is the model's own report, not a count.
const (
	GoalActive       = "active"
	GoalPaused       = "paused"
	GoalUsageLimited = "usage_limited"
	// GoalVerifying means the working model says the objective is done and an
	// independent acceptance turn is judging that claim. It is neither done nor
	// abandoned: the next verdict decides.
	GoalVerifying = "verifying"
	GoalCompleted = "completed"
	// GoalBudgetLimit is the status a goal used to reach when its budget ran
	// out. Budgets are retired: nothing writes it any more, and a stored row
	// that still carries it is read back as GoalPaused.
	GoalBudgetLimit  = "budget_limited"
	goalCommand      = "/goal"
	goalObjectiveMax = 4000
	goalNoteMax      = 500
)

// ConversationGoal is the stored objective of one conversation.
type ConversationGoal struct {
	ConversationID string `json:"conversationId"`
	Objective      string `json:"objective"`
	Status         string `json:"status"`
	// BudgetTokens is the spent-limit of a goal stored before budgets were
	// retired. It is read for historical rows only and never set any more.
	BudgetTokens int64  `json:"budgetTokens"`
	UsedTokens   int64  `json:"usedTokens"`
	CheckNote    string `json:"checkNote,omitempty"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

// Goal reads the goal of one conversation, or nil when it has none.
//
// A row written while budgets existed can still say budget_limited. Reading it
// as paused is what makes `/goal resume` the one way back: reaching a number no
// longer stops a goal, and an old row that says it did is the same situation as
// a person pausing.
func (s *TaskStore) Goal(conversationID string) *ConversationGoal {
	row := kernelRow(s.Db, `SELECT conversation_id,objective,status,budget_tokens,used_tokens,check_note,created_at,updated_at
		FROM conversation_goals WHERE conversation_id=?`, conversationID)
	if row == nil {
		return nil
	}
	status := kernelString(row["status"])
	if status == GoalBudgetLimit {
		status = GoalPaused
	}
	return &ConversationGoal{
		ConversationID: kernelString(row["conversation_id"]), Objective: kernelString(row["objective"]),
		Status: status, BudgetTokens: kernelInt(row["budget_tokens"]),
		UsedTokens: kernelInt(row["used_tokens"]), CheckNote: kernelString(row["check_note"]),
		CreatedAt: kernelInt(row["created_at"]), UpdatedAt: kernelInt(row["updated_at"]),
	}
}

// PutGoal writes the goal of one conversation.
func (s *TaskStore) PutGoal(goal ConversationGoal, now int64) ConversationGoal {
	created := now
	if existing := s.Goal(goal.ConversationID); existing != nil {
		created = existing.CreatedAt
	}
	kernelExec(s.Db, `INSERT INTO conversation_goals(conversation_id,objective,status,budget_tokens,used_tokens,check_note,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(conversation_id) DO UPDATE SET objective=excluded.objective,status=excluded.status,
		budget_tokens=excluded.budget_tokens,used_tokens=excluded.used_tokens,check_note=excluded.check_note,updated_at=excluded.updated_at`,
		goal.ConversationID, goal.Objective, goal.Status, goal.BudgetTokens, goal.UsedTokens, goal.CheckNote, created, now)
	goal.CreatedAt, goal.UpdatedAt = created, now
	return goal
}

// DeleteGoal removes the goal of one conversation.
func (s *TaskStore) DeleteGoal(conversationID string) {
	kernelExec(s.Db, `DELETE FROM conversation_goals WHERE conversation_id=?`, conversationID)
}

// GoalInput is one `/goal` action.
type GoalInput struct {
	Action       string // set, show, pause, resume, clear, done, extend
	Objective    string
	BudgetTokens int64
	CheckNote    string
	RequestID    string
}

// Goal applies one `/goal` action to a conversation.
func (conversations *TaskRuntimeConversations) Goal(conversationID string, input GoalInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationID)
	if conversation.Role == ConversationHistory {
		Raise("invalid_input", "Historical conversations are read-only")
	}
	now := NowMillis()
	action := strings.TrimSpace(input.Action)
	if action == "" {
		action = "show"
	}
	result := map[string]any{"conversationId": conversationID, "command": "goal", "action": action}
	switch action {
	case "show":
		result["goal"] = runtime.store.Goal(conversationID)
	case "set":
		objective := strings.TrimSpace(input.Objective)
		if objective == "" || len(objective) > goalObjectiveMax {
			Raise("invalid_input", "The goal objective must be 1 to 4000 bytes")
		}
		// A number a person still types is not an error and not silence: the
		// objective is set as usual and the goal has no ceiling.
		if input.BudgetTokens > 0 {
			result["budgetIgnored"] = true
		}
		result["goal"] = runtime.store.PutGoal(ConversationGoal{
			ConversationID: conversationID, Objective: objective, Status: GoalActive,
		}, now)
	case "pause", "resume", "clear", "done", "extend":
		goal := runtime.store.Goal(conversationID)
		if goal == nil {
			Raise("invalid_state", "This conversation has no goal to "+action)
		}
		switch action {
		case "pause":
			if goal.Status != GoalActive {
				Raise("invalid_state", "Only an active goal can be paused")
			}
			goal.Status = GoalPaused
		case "resume":
			if goal.Status != GoalPaused && goal.Status != GoalUsageLimited && goal.Status != GoalVerifying {
				Raise("invalid_state", "Only a paused or usage-limited goal can be resumed")
			}
			goal.Status = GoalActive
		case "done":
			if goal.Status == GoalCompleted {
				Raise("invalid_state", "This goal is already completed")
			}
			goal.Status = GoalCompleted
			goal.CheckNote = utf16Slice(strings.TrimSpace(input.CheckNote), goalNoteMax)
		case "extend":
			// `/goal +N` used to buy more turns. There is nothing to buy now,
			// so the command says so and changes nothing.
			if input.BudgetTokens <= 0 {
				Raise("invalid_input", "Extending a goal needs a positive token amount")
			}
			result["budgetIgnored"] = true
			return result
		case "clear":
			runtime.store.DeleteGoal(conversationID)
			result["cleared"] = true
			return result
		}
		result["goal"] = runtime.store.PutGoal(*goal, now)
	default:
		Raise("invalid_input", "Unknown goal action: "+action)
	}
	return result
}

// ParseGoalCommand reads one `/goal …` line. It reports false for anything that
// is not that command, so a normal message is never mistaken for one.
func ParseGoalCommand(text string) (GoalInput, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed != goalCommand && !strings.HasPrefix(trimmed, goalCommand+" ") && !strings.HasPrefix(trimmed, goalCommand+"\n") {
		return GoalInput{}, false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(trimmed, goalCommand))
	switch rest {
	case "":
		return GoalInput{Action: "show"}, true
	case "pause", "resume", "clear":
		return GoalInput{Action: rest}, true
	}
	if rest == "done" || strings.HasPrefix(rest, "done ") || strings.HasPrefix(rest, "done\n") {
		return GoalInput{Action: "done", CheckNote: strings.TrimSpace(strings.TrimPrefix(rest, "done"))}, true
	}
	budget := int64(0)
	if fields := strings.Fields(rest); len(fields) > 0 && strings.HasPrefix(fields[len(fields)-1], "+") {
		if value, err := strconv.ParseInt(fields[len(fields)-1][1:], 10, 64); err == nil && value >= 0 {
			budget = value
			rest = strings.TrimSpace(strings.TrimSuffix(rest, fields[len(fields)-1]))
		}
	}
	// `/goal +N` on its own used to extend the goal it has. It still parses as
	// its own action so the person gets an answer instead of an error.
	if rest == "" && budget > 0 {
		return GoalInput{Action: "extend", BudgetTokens: budget}, true
	}
	return GoalInput{Action: "set", Objective: rest, BudgetTokens: budget}, true
}

// goalStartInstruction is the message a freshly set goal starts its first turn
// from. A goal is an instruction to work, not a note on the thread: without a
// turn the person sets an objective and nothing happens until they speak again
// (measured 2026-11-03: a goal set in the console produced no turn at all). The
// text is short and explicit so the model begins instead of asking whether it
// should.
func goalStartInstruction(goal *ConversationGoal) string {
	return "开始执行这个目标：" + goal.Objective +
		"\n\n不必先向我确认，直接开始推进；需要我裁决时再问。" + goalToolInstruction
}

// goalToolInstruction is the same closing rule on every turn a goal starts: the
// model, not a turn counter, is what ends a goal.
const goalToolInstruction = "\n目标真正完成并已验证时，用 goal 工具（action=complete）收口，并在 note 里报告最终已用 tokens；同一个阻碍连续三轮没解决时用 action=blocked 停下来等我。"

// goalLine is the one visible line a /goal command leaves in the conversation.
func goalLine(action string, goal *ConversationGoal, budgetIgnored bool) string {
	switch action {
	case "set":
		// The card is the live view of the goal; this line is the receipt of
		// the command.
		line := "目标已设定：" + goal.Objective + "（无预算上限：目标会一直推进到完成、被阻碍或你暂停）"
		if budgetIgnored {
			line = "目标已设定：" + goal.Objective + "（已忽略 +N：目标无预算上限，会一直推进到完成、被阻碍或你暂停）"
		}
		return line
	case "clear":
		return "目标已清除。"
	case "done":
		line := "目标已完成：" + goal.Objective
		if goal.CheckNote != "" {
			line += "（" + goal.CheckNote + "）"
		}
		return line
	case "extend":
		return "目标现在没有上限：不需要追加预算，它会一直推进到完成、被阻碍，或你 /goal pause。"
	case "pause":
		return "目标已暂停：" + goal.Objective
	case "resume":
		return "目标已恢复：" + goal.Objective
	}
	if goal == nil {
		return "当前没有目标。用 /goal <目标> 设置。"
	}
	line := "当前目标：「" + goal.Objective + "」（" + goal.Status + "，已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " tokens，未设上限"
	return line + "）"
}

// goalPromptSection is the standing objective as the model sees it. It is
// appended to a master turn's prompt only while the goal is active, so a
// paused, usage-limited or completed goal changes nothing the model reads.
func goalPromptSection(goal *ConversationGoal) string {
	if goal == nil || goal.Status != GoalActive {
		return ""
	}
	funds := "已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " tokens，未设上限"
	return "\n\n# Standing goal\nThis conversation has one standing objective the user set outside the chat. Keep it in view for this turn and prefer work that advances it:\n「" + goal.Objective + "」\n" + funds +
		"\nWhen the objective is genuinely done and verified, call the goal tool with action \"complete\" and report the final used tokens in note. Do not claim completion before the work is verified. If the same blocker has stood for three consecutive turns, call it with action \"blocked\"."
}

// AppendGoalLine writes the single visible line one /goal action leaves in the
// conversation. Both the message endpoint and the first message of a new
// conversation go through it, so the two paths cannot drift.
func AppendGoalLine(store *TaskStore, conversationID, action string, result map[string]any) AppendedMessage {
	var goal *ConversationGoal
	switch value := result["goal"].(type) {
	case *ConversationGoal:
		goal = value
	case ConversationGoal:
		copied := value
		goal = &copied
	}
	ignored, _ := result["budgetIgnored"].(bool)
	return AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
		Text: goalLine(action, goal, ignored), State: MessageStateDone,
		Data: map[string]any{"source": map[string]any{"kind": "goal_command"}, "action": action},
	})
}
