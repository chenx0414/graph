package graph

func controlledResponsesInput(messages []any) []any {
	out := []any{}
	for index := 0; index < len(messages); index++ {
		message, ok := messages[index].(map[string]any)
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
			index = next - 1
			out = append(out, controlledResponsesAssistant(message, results)...)
		default:
			out = append(out, controlledResponsesTextItem("user", "input_text", ControlledTextFromContent(message["content"])))
		}
	}
	return out
}

func controlledResponsesAssistant(message map[string]any, results map[string]map[string]any) []any {
	out := []any{}
	for _, block := range controlledAssistantContent(message) {
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			if text, ok := block["text"].(string); ok && text != "" {
				out = append(out, controlledResponsesTextItem("assistant", "output_text", text))
			}
		case "toolCall":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if id == "" || name == "" {
				continue
			}
			out = append(out, map[string]any{
				"type": "function_call", "call_id": id, "name": name,
				"arguments": stringifyJSON(block["arguments"]),
			})
			output := controlledMissingToolResult
			if result, ok := results[id]; ok {
				output = ControlledTextFromContent(result["content"])
			}
			out = append(out, map[string]any{"type": "function_call_output", "call_id": id, "output": output})
		}
	}
	return out
}

func controlledResponsesTextItem(role, partType, text string) map[string]any {
	return map[string]any{
		"role":    role,
		"content": []any{map[string]any{"type": partType, "text": text}},
	}
}

func controlledResponsesTools(messages []any) []any {
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
		entry := map[string]any{"type": "function", "name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			entry["parameters"] = parameters
		} else {
			entry["parameters"] = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, entry)
	}
	return out
}

func controlledResponsesReasoning(record map[string]any, options map[string]any) map[string]any {
	for name, value := range ControlledThinkingFields(record, options) {
		if name != "reasoning_effort" {
			continue
		}
		effort, ok := value.(string)
		if !ok || effort == "" || effort == "off" {
			return nil
		}
		return map[string]any{"effort": effort}
	}
	return nil
}

func (stream *controlledStream) handleResponsesEvent(event map[string]any) {
	switch rsiText(event["type"]) {
	case "response.output_text.delta":
		if delta, ok := event["delta"].(string); ok && delta != "" {
			stream.appendText(delta)
		}
	case "response.output_item.added":
		item := asMap(event["item"])
		if rsiText(item["type"]) != "function_call" {
			return
		}
		index := int(controlledResponsesIndex(event))
		stream.startToolCall(index, rsiText(item["call_id"]), rsiText(item["name"]))
	case "response.function_call_arguments.delta":
		if delta, ok := event["delta"].(string); ok && delta != "" {
			stream.appendToolArguments(int(controlledResponsesIndex(event)), delta)
		}
	case "response.completed":
		if len(stream.toolCalls) > 0 {
			stream.finishReason = "toolUse"
			return
		}
		stream.finishReason = "stop"
	case "response.failed", "response.incomplete", "error":
		stream.fail(errorString("The provider reported a failed response: " + controlledResponsesReason(event)))
	}
}

func controlledResponsesIndex(event map[string]any) int64 {
	index, ok := controlledSafeCount(event["output_index"])
	if !ok {
		return 0
	}
	return index
}

func controlledResponsesReason(event map[string]any) string {
	response := asMap(event["response"])
	if reason := rsiText(asMap(response["error"])["message"]); reason != "" {
		return reason
	}
	if reason := rsiText(event["message"]); reason != "" {
		return reason
	}
	code := rsiText(asMap(response["error"])["code"])
	if code == "" {
		code = rsiText(event["code"])
	}
	if code == "" {
		code = rsiText(event["type"])
	}
	return "no reason given (" + code + ")"
}

func controlledResponsesUsage(value any) *TokenUsage {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input, inputOK := controlledSafeCount(raw["input_tokens"])
	output, outputOK := controlledSafeCount(raw["output_tokens"])
	if !inputOK || !outputOK {
		return nil
	}
	cache := int64(0)
	if details, ok := raw["input_tokens_details"].(map[string]any); ok {
		if count, ok := controlledSafeCount(details["cached_tokens"]); ok {
			cache = count
		}
	}
	if cache > input {
		return nil
	}
	return &TokenUsage{
		Input: input - cache, Output: output, CacheRead: cache, CacheWrite: 0,
		UsageSource: stringPointer(string(UsageAuthoritative)),
	}
}
