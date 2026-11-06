package graph

import (
	"strconv"
	"strings"
)

// AgentToolsGoal is one call of the goal tool: what the working model says
// about the objective it is working toward.
type AgentToolsGoal struct {
	Action    string
	Note      string
	RequestID string
}

// GoalTool applies one model-reported goal action to the conversation's goal.
//
// The model, not a turn counter, is what ends a goal. Two of the three actions
// are therefore evidence it has to bring:
//
//   - complete: the objective is reached AND verified. The note carries what was
//     verified and the final used tokens, so the person reads one sentence that
//     stands on its own.
//   - blocked: the same blocker has already stood for three consecutive turns.
//     The first time something goes wrong the model must keep working; only a
//     blocker that repeats, worded the same way, pauses the goal for a person.
//   - pause: stop and hand the thread back.
func GoalTool(store *TaskStore, conversationID string, input AgentToolsGoal, modelID string) map[string]any {
	action := strings.TrimSpace(input.Action)
	if action != "complete" && action != "blocked" && action != "pause" {
		Raise("invalid_input", "Unsupported goal action: use complete, blocked or pause")
	}
	note := strings.TrimSpace(input.Note)
	if note == "" {
		Raise("invalid_input", "note is required: say what was verified, what is blocking, or why you stopped")
	}
	requestID := strings.TrimSpace(input.RequestID)
	if requestID == "" || len(requestID) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	receipt, _ := jsonRecord(store.Command("conversation:"+conversationID+":goal", requestID,
		map[string]any{"action": action, "note": note}, func() any {
			goal := store.Goal(conversationID)
			if goal == nil {
				Raise("invalid_state", "This conversation has no goal to act on")
			}
			now := NowMillis()
			switch action {
			case "complete":
				// A claim is not a completion: the goal goes to an independent
				// acceptance turn, and only its verdict can finish the goal.
				if goal.Status == GoalCompleted {
					Raise("invalid_state", "This goal is already completed")
				}
				if goal.Status == GoalVerifying {
					Raise("invalid_state", "An acceptance check is already running for this goal")
				}
				goal.CheckNote = utf16Slice(note, goalNoteMax)
				updated := RequestGoalAcceptance(store, conversationID, *goal, modelID)
				return map[string]any{
					"action": "complete", "status": updated.Status, "usedTokens": updated.UsedTokens,
					"acceptance": "requested", "continues": false,
					"message": "已提交独立验收。验收给出 pass 才收口，给出 fail 会带着理由继续推进。",
				}
			case "blocked":
				repeats, fingerprint := RecordGoalBlocked(store, conversationID, note, now)
				// Three consecutive turns of the identical blocker is the bar for
				// calling the work stuck. A turn counter would stop a goal that is
				// making progress; this stops one that is not.
				if repeats < 3 {
					AppendMessage(store, MessageInput{
						ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
						Text: "模型报告受阻（第 " + strconv.Itoa(repeats) + " 轮）：" + note +
							"。同一阻碍要连续三轮重复才允许停下来等你裁决，目标继续推进。",
						State: MessageStateDone,
						Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "blocked", "repeats": repeats},
					})
					return map[string]any{
						"action": "blocked", "status": goal.Status, "repeats": repeats, "fingerprint": fingerprint,
						"stops":   false,
						"message": "同一阻碍要连续三轮重复才允许标 blocked。现在继续推进，或换一个办法绕过它。",
					}
				}
				goal.Status = GoalPaused
				updated := store.PutGoalForced(*goal, now)
				AppendMessage(store, MessageInput{
					ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
					Text:  "目标被同一个阻碍卡住 " + strconv.Itoa(repeats) + " 轮，已暂停等你裁决：" + note + "。处理完用 /goal resume 继续。",
					State: MessageStateDone,
					Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "blocked", "repeats": repeats},
				})
				store.Event(goalTaskID(store, conversationID), "goal.paused", map[string]any{
					"conversationId": conversationID, "reason": "blocked", "fingerprint": fingerprint, "repeats": repeats,
				})
				return map[string]any{
					"action": "blocked", "status": updated.Status, "repeats": repeats, "fingerprint": fingerprint,
					"stops": true, "message": "目标已暂停，等用户处理这个阻碍后用 /goal resume 继续。",
				}
			}
			if goal.Status != GoalActive {
				Raise("invalid_state", "Only an active goal can be paused")
			}
			goal.Status = GoalPaused
			updated := store.PutGoalForced(*goal, now)
			AppendMessage(store, MessageInput{
				ConversationID: conversationID, Role: MessageRoleSystem, Kind: "goal",
				Text:  "目标已暂停：" + updated.Objective + "（" + note + "）",
				State: MessageStateDone,
				Data:  map[string]any{"source": map[string]any{"kind": "goal_tool"}, "action": "pause"},
			})
			return map[string]any{"action": "pause", "status": updated.Status, "stops": true}
		}))
	if receipt == nil {
		return map[string]any{}
	}
	return receipt
}

// goalTaskID is the task one conversation's events belong to.
func goalTaskID(store *TaskStore, conversationID string) string {
	if conversation := kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationID); conversation != nil {
		return kernelString(conversation["anchor_task_id"])
	}
	return ""
}
