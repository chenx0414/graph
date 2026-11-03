package graph

import (
	"strconv"
	"strings"
)

// A goal is a persistent objective one conversation keeps working toward.
//
// Measured 2026-11-03 (Codex /goal): the objective lives outside the chat as
// one row per thread with a status, a token budget and a completion note, so a
// turn can end while the work continues and the budget can stop it. The same
// separation applies here: a `/goal` line is a command, not a message the model
// has to interpret.
const (
	GoalActive       = "active"
	GoalPaused       = "paused"
	GoalBudgetLimit  = "budget_limited"
	GoalCompleted    = "completed"
	goalCommand      = "/goal"
	goalObjectiveMax = 4000
	goalNoteMax      = 500
)

// ConversationGoal is the stored objective of one conversation.
type ConversationGoal struct {
	ConversationID string `json:"conversationId"`
	Objective      string `json:"objective"`
	Status         string `json:"status"`
	BudgetTokens   int64  `json:"budgetTokens"`
	UsedTokens     int64  `json:"usedTokens"`
	CheckNote      string `json:"checkNote,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	UpdatedAt      int64  `json:"updatedAt"`
}

// Goal reads the goal of one conversation, or nil when it has none.
func (s *TaskStore) Goal(conversationID string) *ConversationGoal {
	row := kernelRow(s.Db, `SELECT conversation_id,objective,status,budget_tokens,used_tokens,check_note,created_at,updated_at
		FROM conversation_goals WHERE conversation_id=?`, conversationID)
	if row == nil {
		return nil
	}
	return &ConversationGoal{
		ConversationID: kernelString(row["conversation_id"]), Objective: kernelString(row["objective"]),
		Status: kernelString(row["status"]), BudgetTokens: kernelInt(row["budget_tokens"]),
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
		if input.BudgetTokens < 0 {
			Raise("invalid_input", "The goal budget must not be negative")
		}
		result["goal"] = runtime.store.PutGoal(ConversationGoal{
			ConversationID: conversationID, Objective: objective, Status: GoalActive,
			BudgetTokens: input.BudgetTokens,
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
			if goal.Status != GoalPaused && goal.Status != GoalBudgetLimit {
				Raise("invalid_state", "Only a paused or budget-limited goal can be resumed")
			}
			goal.Status = GoalActive
		case "done":
			if goal.Status == GoalCompleted {
				Raise("invalid_state", "This goal is already completed")
			}
			goal.Status = GoalCompleted
			goal.CheckNote = utf16Slice(strings.TrimSpace(input.CheckNote), goalNoteMax)
		case "extend":
			if input.BudgetTokens <= 0 {
				Raise("invalid_input", "Extending a goal needs a positive token amount")
			}
			goal.BudgetTokens += input.BudgetTokens
			if goal.Status == GoalBudgetLimit {
				goal.Status = GoalActive
			}
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
	// `/goal +N` extends the goal it already has instead of replacing it.
	if rest == "" && budget > 0 {
		return GoalInput{Action: "extend", BudgetTokens: budget}, true
	}
	return GoalInput{Action: "set", Objective: rest, BudgetTokens: budget}, true
}

// goalLine is the one visible line a /goal command leaves in the conversation.
func goalLine(action string, goal *ConversationGoal) string {
	switch action {
	case "clear":
		return "目标已清除。"
	case "done":
		line := "目标已完成：" + goal.Objective
		if goal.CheckNote != "" {
			line += "（" + goal.CheckNote + "）"
		}
		return line
	case "extend":
		line := "目标预算已延长到 " + strconv.FormatInt(goal.BudgetTokens, 10) + " tokens"
		if goal.Status == GoalBudgetLimit {
			line += "，目标恢复进行中：" + goal.Objective
		} else if goal.Status != GoalActive {
			line += "（目标当前是 " + goal.Status + "，用 /goal <目标> 重新开始）"
		}
		return line
	case "pause":
		return "目标已暂停：" + goal.Objective
	case "resume":
		return "目标已恢复：" + goal.Objective
	}
	if goal == nil {
		return "当前没有目标。用 /goal <目标> 设置。"
	}
	line := "当前目标：「" + goal.Objective + "」（" + goal.Status + "，已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " tokens"
	if goal.BudgetTokens > 0 {
		line += " / 预算 " + strconv.FormatInt(goal.BudgetTokens, 10)
	}
	return line + "）"
}

// goalPromptSection is the standing objective as the model sees it. It is
// appended to a master turn's prompt only while the goal is active, so a
// paused, budget-limited or completed goal changes nothing the model reads.
func goalPromptSection(goal *ConversationGoal) string {
	if goal == nil || goal.Status != GoalActive {
		return ""
	}
	funds := "已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " tokens，未设预算"
	if goal.BudgetTokens > 0 {
		remaining := goal.BudgetTokens - goal.UsedTokens
		if remaining < 0 {
			remaining = 0
		}
		funds = "已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " / 预算 " + strconv.FormatInt(goal.BudgetTokens, 10) +
			" tokens，剩余 " + strconv.FormatInt(remaining, 10)
	}
	return "\n\n# Standing goal\nThis conversation has one standing objective the user set outside the chat. Keep it in view for this turn and prefer work that advances it:\n「" + goal.Objective + "」\n" + funds +
		"\nWhen the objective is genuinely done and verified, say so plainly so the user can run /goal done. Do not claim completion before the work is verified."
}

// AccountGoalUsage adds one settled master turn to the conversation's goal and
// closes the goal once its budget is spent. The transition is visible: the
// console shows the same line a /goal command leaves.
func AccountGoalUsage(store *TaskStore, conversationID string, total int64, now int64) {
	if total <= 0 {
		return
	}
	goal := store.Goal(conversationID)
	if goal == nil || goal.Status != GoalActive {
		return
	}
	goal.UsedTokens += total
	if goal.BudgetTokens > 0 && goal.UsedTokens >= goal.BudgetTokens {
		goal.Status = GoalBudgetLimit
	}
	updated := store.PutGoal(*goal, now)
	if updated.Status == GoalBudgetLimit {
		AppendMessage(store, MessageInput{
			ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
			Text: "目标预算已用完（已用 " + strconv.FormatInt(updated.UsedTokens, 10) + " / 预算 " + strconv.FormatInt(updated.BudgetTokens, 10) +
				" tokens），目标已停止推进。用 /goal +N 追加预算，或 /goal clear 清除目标。",
			State: MessageStateDone,
			Data:  map[string]any{"source": map[string]any{"kind": "goal_command"}, "action": "budget_limited"},
		})
	}
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
	return AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
		Text: goalLine(action, goal), State: MessageStateDone,
		Data: map[string]any{"source": map[string]any{"kind": "goal_command"}, "action": action},
	})
}
