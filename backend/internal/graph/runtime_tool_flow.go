package graph

const controlledMissingToolResult = "No result provided"

func controlledAnthropicCacheControl() map[string]any {
	return map[string]any{"type": "ephemeral"}
}

func controlledAnthropicCacheBreakpoint(messages []any) {
	for index := len(messages) - 1; index >= 0; index-- {
		message, ok := messages[index].(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		if role != "user" && role != "system" {
			continue
		}
		content, ok := message["content"].([]any)
		if !ok || len(content) == 0 {
			return
		}
		last, ok := content[len(content)-1].(map[string]any)
		if !ok {
			return
		}
		switch last["type"] {
		case "text", "image", "tool_result":
			last["cache_control"] = controlledAnthropicCacheControl()
		}
		return
	}
}

type controlledFlowCall struct {
	ID   string
	Name string
}

func controlledToolResults(messages []any, from int) (map[string]map[string]any, int) {
	results := map[string]map[string]any{}
	index := from
	for index < len(messages) {
		message, ok := messages[index].(map[string]any)
		if !ok {
			break
		}
		if role, _ := message["role"].(string); role != "toolResult" {
			break
		}
		id, _ := message["toolCallId"].(string)
		if id != "" {
			if _, seen := results[id]; !seen {
				results[id] = message
			}
		}
		index++
	}
	return results, index
}

func controlledOpenAIToolMessages(calls []controlledFlowCall, results map[string]map[string]any) []any {
	out := []any{}
	for _, call := range calls {
		if result, ok := results[call.ID]; ok {
			out = append(out, map[string]any{
				"role": "tool", "tool_call_id": call.ID,
				"content": controlledOpenAIContent(result["content"]),
			})
			continue
		}
		out = append(out, map[string]any{
			"role": "tool", "tool_call_id": call.ID, "content": controlledMissingToolResult,
		})
	}
	return out
}

func controlledAnthropicAssistant(message map[string]any, results map[string]map[string]any) (map[string]any, []any) {
	blocks := []any{}
	text := ""
	calls := []controlledFlowCall{}
	content, _ := message["content"].([]any)
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			if value, ok := block["text"].(string); ok && value != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": value})
			}
		case "thinking":
			value, _ := block["thinking"].(string)
			signature, _ := block["thinkingSignature"].(string)
			if signature != "" {
				blocks = append(blocks, map[string]any{"type": "thinking", "thinking": value, "signature": signature})
				continue
			}
			text += value
		case "toolCall":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if id == "" || name == "" {
				continue
			}
			input := map[string]any{}
			if value, ok := block["arguments"].(map[string]any); ok {
				input = value
			}
			blocks = append(blocks, map[string]any{"type": "tool_use", "id": id, "name": name, "input": input})
			calls = append(calls, controlledFlowCall{ID: id, Name: name})
		}
	}
	if text != "" {
		blocks = append([]any{map[string]any{"type": "text", "text": text}}, blocks...)
	}
	if len(blocks) == 0 {
		return nil, nil
	}
	assistant := map[string]any{"role": "assistant", "content": blocks}
	if len(calls) == 0 {
		return assistant, nil
	}
	results2 := []any{}
	for _, call := range calls {
		if result, ok := results[call.ID]; ok {
			results2 = append(results2, map[string]any{
				"type": "tool_result", "tool_use_id": call.ID,
				"content": controlledAnthropicContent(result["content"]),
			})
			continue
		}
		results2 = append(results2, map[string]any{
			"type": "tool_result", "tool_use_id": call.ID, "content": controlledMissingToolResult,
		})
	}
	return assistant, []any{map[string]any{"role": "user", "content": results2}}
}
