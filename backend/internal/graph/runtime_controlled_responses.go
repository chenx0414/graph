package graph

// The OpenAI Responses transport (api: "openai-responses").
//
// A Responses request is not a chat-completions request on another path: the
// transcript travels as typed input items (messages, the function calls a turn
// made and the output each call returned), the tool declarations are flat, and
// the answer arrives as `response.*` events. ChatGPT's Codex backend answers in
// this shape only, so the model entry that names it is the reason this
// transport exists.

// controlledResponsesInput renders the transcript as Responses input items.
//
// The system prompt is the request's `instructions`, not an item; a tool result
// is the `function_call_output` of the call it answers, and it travels beside
// that call so the provider reads the flow in the order it happened.
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
			// Rendered with the assistant turn that asked for it.
			continue
		case "system", "developer":
			// The prompt is the request's instructions.
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

// controlledResponsesAssistant renders one assistant turn in the order it was produced.
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

// controlledResponsesTextItem is one text item of the input.
func controlledResponsesTextItem(role, partType, text string) map[string]any {
	return map[string]any{
		"role":    role,
		"content": []any{map[string]any{"type": partType, "text": text}},
	}
}

// controlledResponsesTools renders the transcript tools as Responses declarations:
// flat, with the name and the schema on the tool itself.
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

// controlledResponsesReasoning reads the thinking strength one entry asks for.
//
// A Responses request carries the effort as a named strength inside `reasoning`;
// the entry's own default and the turn's chosen level are read the same way the
// chat-completions fields are, so one configuration means the same thing on both
// transports.
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

// handleResponsesEvent reads one Responses event.
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
		// A turn that called a tool is a tool-use turn whatever the model said
		// after it: the runtime stops the turn on the calls it must run.
		if len(stream.toolCalls) > 0 {
			stream.finishReason = "toolUse"
			return
		}
		stream.finishReason = "stop"
	case "response.failed", "response.incomplete", "error":
		stream.fail(errorString("The provider reported a failed response: " + controlledResponsesReason(event)))
	}
}

// controlledResponsesIndex is the position one output item holds in the answer.
func controlledResponsesIndex(event map[string]any) int64 {
	index, ok := controlledSafeCount(event["output_index"])
	if !ok {
		return 0
	}
	return index
}

// controlledResponsesReason is the reason a failed response names.
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

// controlledResponsesUsage parses the usage one Responses answer reports.
//
// The counts are the ones the provider billed: `input_tokens` includes the
// cached prefix, so the cache read is taken out of the input the same way the
// chat-completions adapter does it.
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
