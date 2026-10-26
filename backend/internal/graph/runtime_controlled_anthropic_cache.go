package graph

// controlledAnthropicCacheControl is the breakpoint Anthropic caches up to.
//
// Anthropic does not cache a prefix on its own: it caches what a breakpoint
// marks, and bills everything else at the full input price on every turn. A
// conversation that runs long enough reaches a prefix of hundreds of thousands
// of tokens, so the three breakpoints below - the system prompt, the tool
// declarations and the conversation so far - are the difference between paying
// for that prefix once and paying for it on every turn of the task.

// controlledAnthropicSystem renders the system prompt as the block Anthropic caches.
func controlledAnthropicSystem(system string) []any {
	return []any{map[string]any{
		"type": "text", "text": system, "cache_control": controlledAnthropicCacheControl(),
	}}
}

// controlledAnthropicCachedTools marks the last tool declaration as a breakpoint.
//
// The tool declarations are the same on every turn of a session, so the prefix
// that ends at them is written once and read from then on.
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

// controlledAnthropicCachedMessages marks the last conversation message as a breakpoint.
//
// The conversation grows by one message per turn, so the prefix that ends at the
// last message is written again each turn - but only the tokens that are new
// since the last turn are written; the rest is read from the cache the previous
// turn left behind.
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

// controlledAnthropicMarkBreakpoint marks the last block of one message.
//
// Anthropic accepts the breakpoint on a text, image or tool result block. A
// message that carries none of them cannot hold the breakpoint, and the search
// for the last message that can goes on.
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
