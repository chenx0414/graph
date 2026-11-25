package graph

import (
	"fmt"
	"strings"
)

func piAdapterTurnOutcome(options PiAdapterOptions, input piAdapterRunInput, turn piAdapterTurnInput, entry ModelEntry, reply string, store *TaskStore, operation Operation, instanceId string) OperationResult {
	if turn.ReloadReceipt != nil && *turn.ReloadReceipt != nil {
		output := map[string]any{"rsiRequestId": fmt.Sprintf("%v", (*turn.ReloadReceipt)["id"])}
		if len(*turn.ToolActivity) > 0 {
			output["toolActivity"] = *turn.ToolActivity
		}
		if len(*turn.Activity) > 0 {
			output["activity"] = *turn.Activity
		}
		return OperationResult{Outcome: "completed", Output: output, Usage: turn.Gate.Total()}
	}
	var output map[string]any
	if turn.Conversation != nil {
		output = map[string]any{"text": reply}
		if len(*turn.ToolActivity) > 0 {
			output["toolActivity"] = *turn.ToolActivity
		}
		if len(*turn.Activity) > 0 {
			output["activity"] = *turn.Activity
		}
	} else {
		output = map[string]any{"text": reply}
	}
	if strings.TrimSpace(reply) == "" {
		unfinished := unfinishedToolCalls(turn)
		finished := len(*turn.ToolActivity)
		if unfinished > 0 || finished > 0 {
			output["unfinishedToolCalls"] = unfinished
			output["toolCalls"] = finished
			output["retryCode"] = "tool_calls_unfinished"
			if IsUnfinishedToolCalls(operation.Context.PreviousOutput) {
				output["retryCode"] = "tool_calls_unfinished_repeated"
				output["error"] = "模型连续两轮在没有给出文字回复前就停下了，本轮已停止；需要人工或新指令才能继续。"
				return OperationResult{Outcome: "failed", Output: output, Usage: turn.Gate.Total()}
			}
			return OperationResult{Outcome: "continue", Output: output, Usage: turn.Gate.Total()}
		}
		output["emptyReply"] = true
	}
	return OperationResult{Outcome: "completed", Output: output, Usage: turn.Gate.Total()}
}

func unfinishedToolCalls(turn piAdapterTurnInput) int {
	if turn.ActiveConversationTools == nil {
		return 0
	}
	return len(turn.ActiveConversationTools)
}
