package graph

const controlledMissingToolResult = "No result provided"

// controlledAnthropicCacheControl is the breakpoint the Anthropic prompt
// cache is written at.
//
// The daemon builds the provider request itself, so the breakpoints that
// make the provider's prompt caching work have to be placed here. Pi places
// three: on the system prompt, on the last tool declaration and on the last
// block of the last message. Without them the provider is never told what to
// keep, and every session pays for its whole prefix again.
func controlledAnthropicCacheControl() map[string]any {
	return map[string]any{"type": "ephemeral"}
}

// controlledAnthropicCacheBreakpoint marks the last block of the last message
// the model reads, so the prefix in front of it is kept.
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

// controlledFlowCall is one tool call an assistant turn made.
type controlledFlowCall struct {
	ID   string
	Name string
}

// controlledToolResults reads the tool results that follow one assistant turn.
//
// A result that answers no call of the turn is an orphan. A provider rejects
// a result whose call it never saw, so the orphan is dropped and the call
// that never got its result is closed with the placeholder.
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

// controlledOpenAIToolMessages renders the tool messages one assistant turn answers with.
func controlledOpenAIToolMessages(calls []controlledFlowCall, results map[string]map[string]any) []any {
	out := []any{}
	for _, call := range calls {
		if result, ok := results[call.ID]; ok {
			out = append(out, map[string]any{
				"role": "tool", "tool_call_id": call.ID,
				"content": ControlledTextFromContent(result["content"]),
			})
			continue
		}
		out = append(out, map[string]any{
			"role": "tool", "tool_call_id": call.ID, "content": controlledMissingToolResult,
		})
	}
	return out
}

// controlledAnthropicAssistant renders one assistant turn and the results that answer it.
//
// Anthropic takes the tool calls as `tool_use` blocks of the assistant turn,
// and every result of that turn as one user turn of `tool_result` blocks. A
// turn that carried a tool call and lost its result is closed with the
// placeholder, so the request the provider sees is a flow it accepts.
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
			// A signed reasoning block is replayed as itself. An unsigned one
			// is plain text: a provider refuses a reasoning block it cannot
			// verify, and the reasoning is still worth sending.
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
				"content": ControlledTextFromContent(result["content"]),
			})
			continue
		}
		results2 = append(results2, map[string]any{
			"type": "tool_result", "tool_use_id": call.ID, "content": controlledMissingToolResult,
		})
	}
	return assistant, []any{map[string]any{"role": "user", "content": results2}}
}
