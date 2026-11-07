package graph

import (
	"fmt"
)

func piAdapterTurnOutcome(options PiAdapterOptions, input piAdapterRunInput, turn piAdapterTurnInput, entry ModelEntry, reply string, store *TaskStore, operation Operation, instanceId string) OperationResult {
	if turn.ReloadReceipt != nil && *turn.ReloadReceipt != nil {
		output := map[string]any{"text": RSI_RELOAD_RECEIPT, "rsiRequestId": fmt.Sprintf("%v", (*turn.ReloadReceipt)["id"])}
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
	return OperationResult{Outcome: "completed", Output: output, Usage: turn.Gate.Total()}
}
