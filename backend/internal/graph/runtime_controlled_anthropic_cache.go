package graph

func controlledAnthropicSystem(system string) []any {
	return []any{map[string]any{
		"type": "text", "text": system, "cache_control": controlledAnthropicCacheControl(),
	}}
}

func controlledAnthropicCachedTools(tools []any) []any {
	if len(tools) == 0 {
		return tools
	}
	out := make([]any, 0, len(tools))
	out = append(out, tools[:len(tools)-1]...)
	last, ok := tools[len(tools)-1].(map[string]any)
	if !ok {
		return append(out, last)
	}
	marked := map[string]any{}
	for key, value := range last {
		marked[key] = value
	}
	marked["cache_control"] = controlledAnthropicCacheControl()
	return append(out, marked)
}

func controlledAnthropicCachedMessages(messages []any) []any {
	for index := len(messages) - 1; index >= 0; index-- {
		message, ok := messages[index].(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		if role != "user" && role != "assistant" {
			continue
		}
		if controlledAnthropicMarkBreakpoint(message) {
			messages[index] = message
			return messages
		}
	}
	return messages
}

func controlledAnthropicMarkBreakpoint(message map[string]any) bool {
	switch content := message["content"].(type) {
	case string:
		if content == "" {
			return false
		}
		message["content"] = []any{map[string]any{
			"type": "text", "text": content, "cache_control": controlledAnthropicCacheControl(),
		}}
		return true
	case []any:
		for index := len(content) - 1; index >= 0; index-- {
			block, ok := content[index].(map[string]any)
			if !ok {
				continue
			}
			kind, _ := block["type"].(string)
			switch kind {
			case "text", "image", "tool_result", "tool_addition", "tool_removal":
				block["cache_control"] = controlledAnthropicCacheControl()
				content[index] = block
				message["content"] = content
				return true
			}
		}
	}
	return false
}
