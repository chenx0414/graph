package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

// AccountGoalUsage adds one settled master turn's tokens to the conversation's
// goal. A budget is not a brake any more, so this only moves the number the
// standing goal reports; what stops a goal is its own status.
//
// A turn that is being judged by the acceptance check still spends the goal:
// the final report has to include the acceptance turn's own usage, so the
// verifying status counts too.
func AccountGoalUsage(store *TaskStore, conversationID string, total int64, now int64) {
	if total <= 0 {
		return
	}
	goal := store.Goal(conversationID)
	if goal == nil || (goal.Status != GoalActive && goal.Status != GoalVerifying) {
		return
	}
	goal.UsedTokens += total
	store.PutGoal(*goal, now)
}

// goalContinueText is the instruction one automatic continuation starts from.
// carry is what the previous round left behind - a rejected acceptance, for
// instance - so the next turn starts from the evidence instead of repeating the
// work that was already judged.
func goalContinueText(goal *ConversationGoal, carry string) string {
	text := "继续推进目标：" + goal.Objective +
		"\n\n这是自动续跑：上一轮结束后目标仍在进行中。接着做，不必向我确认。"
	if note := strings.TrimSpace(carry); note != "" {
		text += "\n" + note
	}
	return text + goalToolInstruction
}

// ContinueGoal turns a settled turn into the next one while the goal is still
// being worked on: a goal is the work, so it does not stop just because one
// turn ended. It reports whether it queued a continuation.
//
// Nothing here counts turns. A goal runs until the model reports it complete or
// blocked, until the provider refuses a turn for capacity reasons, or until the
// person pauses, clears or replaces it. The stops below are the cases where the
// next thing to happen belongs to the person rather than to the goal: a message
// already waiting, a question the model asked, and a goal somebody already
// stopped.
func ContinueGoal(store *TaskStore, conversationID string, now int64, carry string) bool {
	goal := store.Goal(conversationID)
	if goal == nil || goal.Status != GoalActive {
		return false
	}
	if len(PendingMessages(store, conversationID, 1)) > 0 {
		return false
	}
	conversation := ConversationRowOf(store, conversationID)
	if kernelRow(store.Db, "SELECT id FROM questions WHERE task_id=? AND status='open' LIMIT 1", conversation.AnchorTaskId) != nil {
		return false
	}
	// Only a goal stored before budgets were retired can still carry one. Such
	// a row stops here instead of spending past a number its author set.
	if goal.BudgetTokens > 0 && goal.UsedTokens >= goal.BudgetTokens {
		goal.Status = GoalPaused
		store.PutGoal(*goal, now)
		AppendMessage(store, MessageInput{
			ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
			Text: "目标沿用了历史数据里的预算（已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " / 预算 " + strconv.FormatInt(goal.BudgetTokens, 10) +
				" tokens），已暂停。用 /goal resume 继续：目标现在没有上限。",
			State: MessageStateDone,
			Data:  map[string]any{"source": map[string]any{"kind": "goal_command"}, "action": "budget_limited"},
		})
		return false
	}
	AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleUser, Kind: "chat",
		Text: goalContinueText(goal, carry), State: MessageStatePending,
		Data: map[string]any{"source": map[string]any{"kind": "goal_continue", "objective": goal.Objective}},
	})
	return true
}

// MarkGoalUsageLimited stops an active goal when the provider refused this turn
// for capacity reasons (HTTP 429 or 503 before any work). The goal is not
// wrong and the objective is not done, so the status says what happened and
// `/goal resume` is the way back once the quota exists again.
func MarkGoalUsageLimited(store *TaskStore, conversationID string, now int64) bool {
	goal := store.Goal(conversationID)
	if goal == nil || (goal.Status != GoalActive && goal.Status != GoalVerifying) {
		return false
	}
	goal.Status = GoalUsageLimited
	updated := store.PutGoal(*goal, now)
	AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
		Text:  "这一轮遇到 provider 的额度/容量限制（429/503），目标已停止续跑。额度恢复后用 /goal resume 继续。",
		State: MessageStateDone,
		Data:  map[string]any{"source": map[string]any{"kind": "goal_command"}, "action": "usage_limited"},
	})
	store.Event(goalTaskID(store, conversationID), "goal.usage_limited", map[string]any{
		"conversationId": conversationID, "usedTokens": updated.UsedTokens,
	})
	return true
}

// goalFingerprint is the stable identity of one blocker. The model words the
// same problem slightly differently each turn, so the fingerprint folds case
// and spacing instead of comparing the note literally.
func goalFingerprint(note string) string {
	normalized := strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(note))), " ")
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:8])
}

// RecordGoalBlocked records one blocker the model reported and returns how many
// consecutive turns that same blocker has now stood for.
//
// The trail lives in the event stream (`goal.blocked`, one event per report,
// carrying the fingerprint) rather than in a schema column: the question "how
// long has this same blocker stood?" is answered by the tail of the stream.
func RecordGoalBlocked(store *TaskStore, conversationID, note string, now int64) (int, string) {
	goal := store.Goal(conversationID)
	if goal == nil {
		Raise("invalid_state", "This conversation has no goal to mark blocked")
	}
	fingerprint := goalFingerprint(note)
	taskID := goalTaskID(store, conversationID)
	store.Event(taskID, "goal.blocked", map[string]any{
		"conversationId": conversationID, "fingerprint": fingerprint, "note": utf16Slice(note, goalNoteMax),
	})
	return goalEventRepeats(store, taskID, conversationID, "goal.blocked", fingerprint), fingerprint
}

// goalEventRepeats counts how many times in a row the newest tail of one event
// type carries the same fingerprint for this conversation. A different
// fingerprint, or any other event of that type, ends the run.
func goalEventRepeats(store *TaskStore, taskID, conversationID, eventType, fingerprint string) int {
	repeats := 0
	rows := kernelRows(store.Db, "SELECT data FROM events WHERE task_id=? AND type=? ORDER BY cursor DESC LIMIT 64", taskID, eventType)
	for _, row := range rows {
		raw := kernelString(row["data"])
		if raw == "" {
			break
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			break
		}
		if kernelString(parsed["conversationId"]) != conversationID || kernelString(parsed["fingerprint"]) != fingerprint {
			break
		}
		repeats++
	}
	return repeats
}
