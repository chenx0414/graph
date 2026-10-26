package graph

import (
	"os"
	"strings"
	"time"

	"fmt"
)

// piAdapterTurnOutcome is what a finished turn leaves behind: the composer
// suggestion, the sedimentation, the reload handoff and the operation's own
// output.
//
// It was the tail of one very long function, so the part of a turn that
// happens after the model answered could not be read on its own.
func piAdapterTurnOutcome(options PiAdapterOptions, input piAdapterRunInput, turn piAdapterTurnInput, entry ModelEntry, reply string, store *TaskStore, operation Operation, instanceId string) OperationResult {
	var suggestedPrompt *string
	var suggestionUsage *TokenUsage
	var suggestionReply *PromptSuggestionReply
	suggestionTimeoutMs := PROMPT_SUGGESTION_TIMEOUT_MS
	if os.Getenv("GRAPH_EXTENDED_PROMPT_SUGGESTION_TIMEOUT") == "1" {
		suggestionTimeoutMs = 20_000
	}
	suggestionTimedOut := false
	lastUserMessage := ""
	for i := len(operation.Context.Messages) - 1; i >= 0; i-- {
		if strings.TrimSpace(operation.Context.Messages[i].Text) != "" {
			lastUserMessage = operation.Context.Messages[i].Text
			break
		}
	}
	var suggestionEntry *ModelEntry
	if turn.Conversation != nil && lastUserMessage != "" {
		suggestionEntry = SelectPromptSuggestionModel(entry, piAdapterCallableModels(options.Directory(), input.ResolveBinding))
	}
	if suggestionEntry != nil && strings.TrimSpace(reply) != "" {
		suggestionNodeId := operation.NodeId
		suggestionGate := TaskGate(store, TaskGateOperation{
			Id: operation.Id, TaskId: operation.TaskId, InstanceId: instanceId, NodeId: &suggestionNodeId,
		}, *suggestionEntry, TaskGateOptions{Optional: true})
		suggestionGate.SetPurpose("prompt_suggestion")
		signal := NewAbortSignal()
		timer := time.AfterFunc(time.Duration(suggestionTimeoutMs)*time.Millisecond, func() {
			suggestionTimedOut = true
			signal.Abort()
		})
		suggestionReply = piAdapterGenerateSuggestion(options, *suggestionEntry, suggestionGate, input, lastUserMessage, reply, signal)
		timer.Stop()
		if suggestionReply.Text != "" {
			suggested := suggestionReply.Text
			suggestedPrompt = &suggested
		}
		suggestionUsage = suggestionGate.Total()
	}
	// A failed call and a model that had nothing to suggest used to collapse into the same
	// silent `undefined`. The decision now travels with the turn, with the call's own words.
	if turn.Conversation != nil {
		decision := map[string]any{
			"operationId": operation.Id, "nodeId": operation.NodeId, "model": nil,
			"asked":     suggestionEntry != nil && strings.TrimSpace(reply) != "",
			"timeoutMs": nil, "timedOut": suggestionTimedOut, "stopReason": nil, "error": nil,
			"chars": 0, "suggestion": "", "replyHead": "",
		}
		if suggestionEntry != nil {
			decision["model"] = suggestionEntry.Id
		}
		if suggestionEntry != nil && strings.TrimSpace(reply) != "" {
			decision["timeoutMs"] = suggestionTimeoutMs
		}
		if suggestionReply != nil {
			if suggestionReply.StopReason != nil {
				decision["stopReason"] = *suggestionReply.StopReason
			}
			if suggestionReply.Error != nil {
				decision["error"] = *suggestionReply.Error
			}
			decision["chars"] = len([]rune(suggestionReply.Raw))
			decision["suggestion"] = suggestionReply.Text
			decision["replyHead"] = truncateRunes(suggestionReply.Raw, 200)
		}
		store.Event(operation.TaskId, "prompt_suggestion.decided", decision)
	}
	// Sedimentation runs after the turn like the composer suggestion does: one extra call on
	// a cheaper model, through the same gate, and the write happens in `applySedimentProposal`
	// so it cannot escape the project's skill folder. Never allowed to break the turn.
	if turn.Conversation != nil && options.Sediment != nil {
		piAdapterRunSediment(options, input, turn, entry, reply, lastUserMessage)
	}
	// The reload handoff keeps its own output: the console shows the receipt, while the review
	// above already read the change itself.
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
	// External main returns its visible reply and recorded conversation activity.
	var output map[string]any
	if turn.Conversation != nil {
		output = map[string]any{"text": reply}
		if suggestedPrompt != nil {
			output["suggestedPrompt"] = *suggestedPrompt
		}
		if len(*turn.ToolActivity) > 0 {
			output["toolActivity"] = *turn.ToolActivity
		}
		if len(*turn.Activity) > 0 {
			output["activity"] = *turn.Activity
		}
	} else {
		output = map[string]any{"text": reply}
	}
	return OperationResult{Outcome: "completed", Output: output, Usage: combineKnownUsage(turn.Gate.Total(), suggestionUsage)}
}
