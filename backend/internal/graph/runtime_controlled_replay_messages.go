package graph

// controlledOpenAIMessages turns a transcript into OpenAI messages.
//
// The system messages collapse into the one leading system message a chat completions
// request carries the prompt in. The instruction role is the one the provider accepts:
// a reasoning model on a standard provider gets `developer`, everything else `system`.
func controlledOpenAIMessages(messages []any, instructionRole string) []any {
	out := []any{}
	head := controlledCurrentSystemMessage(messages)
	if head.present() {
		if text := head.text(); text != "" {
			out = append(out, map[string]any{"role": instructionRole, "content": text})
		}
	}
	for index := 0; index < len(messages); index++ {
		item := messages[index]
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "toolResult":
			// The result is rendered with the assistant turn that asked for it.
			continue
		case "system", "developer":
			continue
		case "assistant":
			results, next := controlledToolResults(messages, index+1)
			assistant, toolMessages := controlledOpenAIAssistant(message, results)
			index = next - 1
			if assistant == nil {
				continue
			}
			out = append(out, assistant)
			out = append(out, toolMessages...)
		default:
			out = append(out, map[string]any{"role": "user", "content": ControlledTextFromContent(message["content"])})
		}
	}
	return out
}

// controlledOpenAIAssistant renders one assistant message the way the SDK does.
//
// The assistant keeps its own role: a model that reads its own tool call back as a
// user turn does not recognize the call it made, and a tool result without the
// assistant turn that asked for it is a request no provider accepts. The text is
// the content, every tool call the message made is an OpenAI tool call, and the
// reasoning the provider sent is sent back in the field the provider itself used.
//
// The reasoning is sent back because a model that cannot read its own reasoning
// reconstructs its plan from the question again, and pays output tokens for it on
// every turn of a long task.
func controlledOpenAIAssistant(message map[string]any, results map[string]map[string]any) (map[string]any, []any) {
	text := ""
	reasoning := ""
	reasoningField := ""
	calls := []any{}
	for _, block := range controlledAssistantContent(message) {
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			if value, ok := block["text"].(string); ok {
				text += value
			}
		case "thinking":
			if value, ok := block["thinking"].(string); ok && value != "" {
				reasoning += value
			}
			if signature, ok := block["thinkingSignature"].(string); ok && signature != "" && reasoningField == "" {
				reasoningField = signature
			}
		case "toolCall":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if id == "" || name == "" {
				continue
			}
			calls = append(calls, map[string]any{
				"id": id, "type": "function",
				"function": map[string]any{"name": name, "arguments": stringifyJSON(block["arguments"])},
			})
		}
	}
	if text == "" && len(calls) == 0 && reasoning == "" {
		// The SDK skips an assistant message that carries neither text nor a tool
		// call; an empty one is a request no provider accepts.
		return nil, nil
	}
	assistant := map[string]any{"role": "assistant", "content": nil}
	if text != "" {
		assistant["content"] = text
	} else if len(calls) == 0 {
		// A turn that carries only reasoning still has to carry some content: a
		// provider that requires either content or tool calls refuses a null.
		assistant["content"] = ""
	}
	if reasoning != "" && controlledReasoningFields[reasoningField] {
		assistant[reasoningField] = reasoning
	}
	if len(calls) > 0 {
		assistant["tool_calls"] = calls
	}
	pending := []controlledFlowCall{}
	for _, item := range calls {
		call := asMap(item)
		pending = append(pending, controlledFlowCall{ID: mapString(call, "id"), Name: mapString(asMap(call["function"]), "name")})
	}
	return assistant, controlledOpenAIToolMessages(pending, results)
}

// controlledAnthropicMessages turns a transcript into Anthropic messages.
func controlledAnthropicMessages(messages []any) []any {
	out := []any{}
	for index := 0; index < len(messages); index++ {
		item := messages[index]
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "toolResult":
			// The result is rendered with the assistant turn that asked for it.
			continue
		case "assistant":
			results, next := controlledToolResults(messages, index+1)
			assistant, resultMessages := controlledAnthropicAssistant(message, results)
			index = next - 1
			if assistant == nil {
				continue
			}
			out = append(out, assistant)
			out = append(out, resultMessages...)
		case "system", "developer":
			continue
		default:
			out = append(out, map[string]any{"role": "user", "content": ControlledTextFromContent(message["content"])})
		}
	}
	return out
}

// controlledContextMessages reads the messages one context carries.
func controlledContextMessages(context map[string]any) []any {
	if context == nil {
		return nil
	}
	messages, _ := context["messages"].([]any)
	return messages
}

// controlledOpenAITools turns the transcript tools into OpenAI tool declarations.
func controlledOpenAITools(messages []any) []any {
	out := []any{}
	for _, tool := range controlledCurrentTools(messages) {
		declaration, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := declaration["name"].(string)
		if name == "" {
			continue
		}
		description, _ := declaration["description"].(string)
		function := map[string]any{"name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			function["parameters"] = parameters
		}
		out = append(out, map[string]any{"type": "function", "function": function})
	}
	return out
}

// controlledAnthropicTools turns the transcript tools into Anthropic tool declarations.
func controlledAnthropicTools(messages []any) []any {
	out := []any{}
	for _, tool := range controlledCurrentTools(messages) {
		declaration, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := declaration["name"].(string)
		if name == "" {
			continue
		}
		description, _ := declaration["description"].(string)
		tool := map[string]any{"name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			tool["input_schema"] = parameters
		}
		out = append(out, tool)
	}
	return out
}

// controlledContextTools reads the tool declarations one context carries.
func controlledContextTools(context map[string]any) []any {
	if context == nil {
		return nil
	}
	tools, _ := context["tools"].([]any)
	return tools
}
