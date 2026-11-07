package pigkernel

import (
	"encoding/json"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable/harness"
)

func translateEvent(event harness.AgentEvent) []map[string]any {
	switch value := event.(type) {
	case harness.RunStartEvent:
		return []map[string]any{{"type": "agent_start"}}
	case harness.RunEndEvent:
		return []map[string]any{{"type": "agent_end"}}
	case harness.TurnStartEvent:
		return []map[string]any{{"type": "turn_start"}}
	case harness.TurnEndEvent:
		return []map[string]any{{"type": "turn_end"}}
	case harness.CompactionStartEvent:
		return []map[string]any{{"type": "compaction_start", "reason": string(value.Reason)}}
	case harness.MessageStartEvent:
		message := messageMap(value.Message)
		return []map[string]any{{"type": "message_start", "message": message}}
	case harness.MessageUpdateEvent:
		reports := []map[string]any{}
		for _, change := range value.Changes {
			if change.Type != "text_delta" {
				continue
			}
			reports = append(reports, map[string]any{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"type": "text_delta", "contentIndex": change.ContentIndex, "delta": change.Delta,
				},
			})
		}
		return reports
	case harness.MessageEndEvent:
		reports := []map[string]any{}
		for _, message := range value.Entry.Model {
			report := messageMap(message)
			reports = append(reports, map[string]any{"type": "message_end", "message": report})
		}
		return reports
	case harness.ToolExecutionStartEvent:
		args := map[string]any{}
		if value.Args != nil {
			for name, item := range value.Args.All() {
				args[name] = item
			}
		}
		return []map[string]any{{
			"type": "tool_execution_start", "toolName": value.ToolName, "toolCallId": value.ToolCallId,
			"args": args,
		}}
	case harness.ToolExecutionEndEvent:
		result := map[string]any{"content": []any{}}
		failed := true
		if value.Entry != nil {
			for _, message := range value.Entry.Model {
				if outcome, ok := message.(ai.ToolResultMessage); ok {
					text := toolResultText(outcome)
					result["content"] = []any{map[string]any{"type": "text", "text": text}}
					failed = outcome.IsError
				}
			}
		}
		return []map[string]any{{
			"type": "tool_execution_end", "toolName": value.ToolName, "toolCallId": value.ToolCallId,
			"isError": failed, "result": result,
		}}
	}
	return nil
}

func messageMap(message ai.Message) map[string]any {
	body, err := json.Marshal(message)
	if err != nil {
		return map[string]any{}
	}
	decoded := map[string]any{}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return map[string]any{}
	}
	return decoded
}

func toolResultText(message ai.ToolResultMessage) string {
	text := ""
	for _, block := range message.Content {
		if content, ok := block.(ai.TextContent); ok {
			text += content.Text
		}
	}
	return text
}
