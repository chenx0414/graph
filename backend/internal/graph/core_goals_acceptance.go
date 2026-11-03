package graph

import (
	"encoding/json"
	"strconv"
	"strings"
)

// A completion claim is not a completed goal. When the working model says the
// objective is done, the goal enters an independent acceptance turn: a separate
// prompt that reads the objective and the claim, gathers its own evidence from
// the workspace, the tests and the artifacts, and answers with a structured
// pass|fail plus one reason per item.
//
// Three outcomes, and none of them is "assume pass":
//
//   - pass    the goal is completed, and the final report carries the verdict
//     and its reasons plus the tokens spent INCLUDING this acceptance turn.
//   - fail    the goal goes back to active and the reasons travel into the next
//     continuation instruction, so the next turn works on what was wrong.
//   - error   the acceptance turn produced no verdict (the provider failed, the
//     answer was empty, or it did not parse). It is not a pass: nothing is
//     completed and nothing advances this turn.
//
// The goal is the same model as the working turn, so independence is limited;
// that limitation is recorded on the acceptance event instead of being implied.

// goalAcceptancePrompt is the one instruction the acceptance turn starts from.
func goalAcceptancePrompt(goal *ConversationGoal, claim, answer string) string {
	evidence := strings.TrimSpace(answer)
	if evidence == "" {
		evidence = "（实施回合没有给出文字答复）"
	}
	return "独立验收请求。你是验收方，不是刚才的实施者：不要接着上一轮的思路作答，也不要在验收中修改任何文件或继续推进目标。\n\n" +
		"目标原文：\n「" + goal.Objective + "」\n\n" +
		"实施方的完成声明：\n" + strings.TrimSpace(claim) + "\n\n" +
		"实施方最后一条答复：\n" + utf16Slice(evidence, 2000) + "\n\n" +
		"目标到本轮为止已用 " + strconv.FormatInt(goal.UsedTokens, 10) + " tokens。\n\n" +
		"请只按可复核的证据判断：\n" +
		"- 工作区改动与文件：用 read / bash / git 查看相关文件与 diff；\n" +
		"- 测试输出：实跑相关测试，或读已有的测试输出；\n" +
		"- artifact 内容摘要：用 artifact 工具读出相关交付物。\n\n" +
		"答复必须结构化，第一行二选一，其余每行一条理由：\n" +
		"VERDICT: pass\n" +
		"- [pass] <验收点>: <理由>\n" +
		"或\n" +
		"VERDICT: fail\n" +
		"- [fail] <验收点>: <理由>\n" +
		"只有每个验收点都通过才能写 pass；证据不足或无法复核时写 fail，并说明缺什么证据。"
}

// RequestGoalAcceptance turns a completion claim into an acceptance request.
func RequestGoalAcceptance(store *TaskStore, conversationID string, goal ConversationGoal, modelID string) ConversationGoal {
	goal.Status = GoalVerifying
	updated := store.PutGoal(goal, NowMillis())
	AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
		Text:  "目标完成声明已提交，进入独立验收：" + updated.Objective + "（" + updated.CheckNote + "）",
		State: MessageStateDone,
		Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "acceptance_requested"},
	})
	// The acceptance turn runs with the conversation's model, which is also the
	// working model. Saying so is part of the record: an acceptance nobody can
	// describe the independence of is not evidence.
	store.Event(goalTaskID(store, conversationID), "goal.acceptance_requested", map[string]any{
		"conversationId": conversationID, "objective": updated.Objective, "claim": updated.CheckNote,
		"usedTokens": updated.UsedTokens, "implementationModel": modelID, "acceptanceModel": modelID, "sameModel": true,
	})
	return updated
}

// goalAcceptanceQueued reports whether the newest user message of the
// conversation is the acceptance instruction. The turn that answers it is the
// verification turn; every other settled turn while the goal is verifying is
// the one that asked for it.
func goalAcceptanceQueued(store *TaskStore, conversationID string) bool {
	row := kernelRow(store.Db, "SELECT data FROM messages WHERE conversation_id=? AND role='user' ORDER BY seq DESC LIMIT 1", conversationID)
	if row == nil {
		return false
	}
	return goalSourceKind(kernelString(row["data"])) == "goal_acceptance"
}

// goalSourceKind reads data.source.kind of one stored message.
func goalSourceKind(data string) string {
	if strings.TrimSpace(data) == "" {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		return ""
	}
	source, _ := parsed["source"].(map[string]any)
	kind, _ := source["kind"].(string)
	return kind
}

// QueueGoalAcceptance starts the independent acceptance turn for a claim that
// just settled. It respects the same stops a continuation respects: a person's
// waiting message or an open question is what happens next, not a review.
func QueueGoalAcceptance(store *TaskStore, conversationID, answer string, now int64) bool {
	goal := store.Goal(conversationID)
	if goal == nil || goal.Status != GoalVerifying {
		return false
	}
	if len(PendingMessages(store, conversationID, 1)) > 0 {
		return false
	}
	conversation := ConversationRowOf(store, conversationID)
	if kernelRow(store.Db, "SELECT id FROM questions WHERE task_id=? AND status='open' LIMIT 1", conversation.AnchorTaskId) != nil {
		return false
	}
	AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleUser, Kind: "chat",
		Text: goalAcceptancePrompt(goal, goal.CheckNote, answer), State: MessageStatePending,
		Data: map[string]any{"source": map[string]any{"kind": "goal_acceptance", "objective": goal.Objective}},
	})
	return true
}

// SettleGoalTurn is what a settled master turn does to the conversation's goal:
// a working turn continues the goal, and a turn that answered an acceptance
// request is adjudicated instead of continued.
func SettleGoalTurn(store *TaskStore, conversationID string, answer string, now int64) {
	goal := store.Goal(conversationID)
	if goal == nil {
		return
	}
	switch goal.Status {
	case GoalActive:
		ContinueGoal(store, conversationID, now, "")
	case GoalVerifying:
		if goalAcceptanceQueued(store, conversationID) {
			AdjudicateGoalAcceptance(store, conversationID, answer, now)
			return
		}
		QueueGoalAcceptance(store, conversationID, answer, now)
	}
}

// AdjudicateGoalAcceptance reads one acceptance answer and applies its verdict.
func AdjudicateGoalAcceptance(store *TaskStore, conversationID, answer string, now int64) {
	goal := store.Goal(conversationID)
	if goal == nil || goal.Status != GoalVerifying {
		return
	}
	verdict, reasons := parseGoalVerdict(answer)
	taskID := goalTaskID(store, conversationID)
	if verdict == "" {
		// Not a pass. An acceptance that could not be read is a failed round:
		// nothing completes and nothing advances.
		FailGoalAcceptance(store, conversationID, "验收回合没有给出可解析的 pass/fail 结论（原文："+utf16Slice(strings.TrimSpace(answer), 200)+"）", now)
		return
	}
	summary := strings.Join(reasons, "；")
	if verdict == "pass" {
		goal.Status = GoalCompleted
		goal.CheckNote = utf16Slice("验收通过："+summary, goalNoteMax)
		updated := store.PutGoal(*goal, now)
		AppendMessage(store, MessageInput{
			ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
			Text: "目标已完成（已用 " + strconv.FormatInt(updated.UsedTokens, 10) + " tokens，含验收轮）：" + updated.Objective +
				"\n验收结论：通过\n" + strings.Join(reasons, "\n"),
			State: MessageStateDone,
			Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "acceptance_passed", "verdict": "pass"},
		})
		store.Event(taskID, "goal.completed", map[string]any{
			"conversationId": conversationID, "verdict": "pass", "reasons": reasons, "usedTokens": updated.UsedTokens,
		})
		return
	}
	// fail: the goal is not completed. The reasons become the next turn's
	// instruction, and the fingerprint of those reasons is what the blocked
	// threshold counts.
	fingerprint := goalFingerprint(summary)
	store.Event(taskID, "goal.acceptance_failed", map[string]any{
		"conversationId": conversationID, "fingerprint": fingerprint, "reasons": reasons,
	})
	repeats := goalEventRepeats(store, taskID, conversationID, "goal.acceptance_failed", fingerprint)
	goal.Status = GoalActive
	updated := store.PutGoal(*goal, now)
	AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
		Text:  "验收未通过（第 " + strconv.Itoa(repeats) + " 轮）：" + summary,
		State: MessageStateDone,
		Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "acceptance_failed", "repeats": repeats},
	})
	if repeats >= 3 {
		// The same reasons three times is evidence the goal cannot pass without
		// a person: the same bar a model-reported blocker has to clear.
		goal.Status = GoalPaused
		paused := store.PutGoal(*goal, now)
		AppendMessage(store, MessageInput{
			ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
			Text:  "同一个验收理由连续 " + strconv.Itoa(repeats) + " 轮没有解决，目标已暂停等你裁决：" + updated.Objective + "。处理完用 /goal resume 继续。",
			State: MessageStateDone,
			Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "acceptance_blocked", "repeats": repeats},
		})
		store.Event(taskID, "goal.paused", map[string]any{
			"conversationId": conversationID, "reason": "acceptance_failed", "fingerprint": fingerprint, "repeats": repeats,
		})
		_ = paused
		return
	}
	ContinueGoal(store, conversationID, now, "上一轮验收没有通过，原因："+summary+"\n先修掉这些，再重新声明完成。")
}

// parseGoalVerdict reads a structured acceptance answer. An answer without a
// parseable verdict is not a pass, and a verdict without a single reason is not
// structured enough to act on.
func parseGoalVerdict(answer string) (string, []string) {
	verdict := ""
	reasons := []string{}
	for _, line := range strings.Split(answer, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		upper := strings.ToUpper(trimmed)
		if strings.HasPrefix(upper, "VERDICT:") {
			value := strings.ToLower(strings.TrimSpace(trimmed[len("VERDICT:"):]))
			if value == "pass" || value == "fail" {
				verdict = value
			}
			continue
		}
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			reasons = append(reasons, utf16Slice(trimmed, 300))
		}
	}
	if len(reasons) > 8 {
		reasons = reasons[:8]
	}
	if len(reasons) == 0 {
		return "", nil
	}
	return verdict, reasons
}

// FailGoalAcceptance records an acceptance turn that produced no usable verdict.
// It is never a pass: the goal goes back to active, nothing completes, and the
// next turn is the person's or the next `/goal resume`, not another automatic
// advance.
func FailGoalAcceptance(store *TaskStore, conversationID, reason string, now int64) bool {
	goal := store.Goal(conversationID)
	if goal == nil || goal.Status != GoalVerifying {
		return false
	}
	goal.Status = GoalActive
	updated := store.PutGoal(*goal, now)
	AppendMessage(store, MessageInput{
		ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
		Text:  "验收没有得出结论，本轮不推进也不完成：" + updated.Objective + "。" + utf16Slice(strings.TrimSpace(reason), 300),
		State: MessageStateDone,
		Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "acceptance_error"},
	})
	store.Event(goalTaskID(store, conversationID), "goal.acceptance_error", map[string]any{
		"conversationId": conversationID, "reason": utf16Slice(strings.TrimSpace(reason), 500),
	})
	return true
}
