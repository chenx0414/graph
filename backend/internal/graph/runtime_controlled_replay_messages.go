package graph

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
			out = append(out, map[string]any{"role": "user", "content": controlledOpenAIContent(message["content"])})
		}
	}
	return out
}

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
		return nil, nil
	}
	assistant := map[string]any{"role": "assistant", "content": nil}
	if text != "" {
		assistant["content"] = text
	} else if len(calls) == 0 {
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
			out = append(out, map[string]any{"role": "user", "content": controlledAnthropicContent(message["content"])})
		}
	}
	return out
}

func controlledContextMessages(context map[string]any) []any {
	if context == nil {
		return nil
	}
	messages, _ := context["messages"].([]any)
	return messages
}

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

func controlledContextTools(context map[string]any) []any {
	if context == nil {
		return nil
	}
	tools, _ := context["tools"].([]any)
	return tools
}
