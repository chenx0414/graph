package graph

import "strings"

// controlledReasoningFields are the assistant-message fields an OpenAI-compatible
// provider reads its reasoning back from.
//
// The provider names the field it used; the answer keeps that name in the block's
// signature. A field that is not one of these is a provider's own detail and is not
// sent back.
var controlledReasoningFields = map[string]bool{
	"reasoning": true, "reasoning_content": true, "reasoning_text": true,
}

// controlledAssistantContent reads the blocks one assistant turn carries.
func controlledAssistantContent(message map[string]any) []map[string]any {
	content, _ := message["content"].([]any)
	blocks := make([]map[string]any, 0, len(content))
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		blocks = append(blocks, block)
	}
	return blocks
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
func controlledOpenAIAssistant(message map[string]any) (map[string]any, bool) {
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
			if name == "" {
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
		return nil, false
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
	return assistant, true
}

// controlledAnthropicAssistantContent renders one assistant turn the way Anthropic
// reads it.
//
// The turn keeps every block it carries: the text, the reasoning with its signature
// and the tool calls. A turn that loses its reasoning is a turn the model cannot
// continue its own reasoning from, and a turn that loses its tool calls is a turn
// whose tool results no longer answer anything.
func controlledAnthropicAssistantContent(message map[string]any) []any {
	blocks := []any{}
	for _, block := range controlledAssistantContent(message) {
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			value, _ := block["text"].(string)
			if strings.TrimSpace(value) == "" {
				continue
			}
			blocks = append(blocks, map[string]any{"type": "text", "text": value})
		case "thinking":
			reasoning, _ := block["thinking"].(string)
			signature, _ := block["thinkingSignature"].(string)
			redacted, _ := block["redacted"].(bool)
			if redacted {
				if signature == "" {
					continue
				}
				blocks = append(blocks, map[string]any{"type": "redacted_thinking", "data": signature})
				continue
			}
			if strings.TrimSpace(signature) == "" {
				// Reasoning the provider signed not at all cannot be handed back as
				// reasoning: Anthropic refuses a thinking block without its signature.
				// The reasoning itself still says what the model was thinking, so it is
				// kept as text.
				if strings.TrimSpace(reasoning) == "" {
					continue
				}
				blocks = append(blocks, map[string]any{"type": "text", "text": reasoning})
				continue
			}
			blocks = append(blocks, map[string]any{"type": "thinking", "thinking": reasoning, "signature": signature})
		case "toolCall":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if name == "" {
				continue
			}
			arguments := block["arguments"]
			if arguments == nil {
				arguments = map[string]any{}
			}
			blocks = append(blocks, map[string]any{"type": "tool_use", "id": id, "name": name, "input": arguments})
		}
	}
	return blocks
}

// controlledOpenAIReasoningDelta reads the reasoning one OpenAI delta carries.
//
// The provider names the field it used, and it may name more than one: the first
// field that carries reasoning is the one the answer came from. The name is kept in
// the block's signature, so the reasoning is sent back later in the same field the
// provider read it from.
func controlledOpenAIReasoningDelta(delta map[string]any) (string, string) {
	for _, field := range []string{"reasoning_content", "reasoning", "reasoning_text"} {
		value, ok := delta[field].(string)
		if !ok || value == "" {
			continue
		}
		return field, value
	}
	return "", ""
}

// partial is the live message one event carries.
func (stream *controlledStream) partial() map[string]any {
	return asMap(stream.message)
}

// appendText adds text to the current text block.
func (stream *controlledStream) appendText(text string) {
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "text" {
		stream.startText(len(stream.message.Content))
		index = len(stream.message.Content) - 1
	}
	stream.appendTextAt(index, text)
}

// appendTextAt adds text to one text block.
func (stream *controlledStream) appendTextAt(index int, text string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	block := &stream.message.Content[index]
	block.Text += text
	stream.events = append(stream.events, map[string]any{
		"type": "text_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
	})
}

// startText opens one text block.
func (stream *controlledStream) startText(index int) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "text"}
	stream.events = append(stream.events, map[string]any{
		"type": "text_start", "contentIndex": index, "partial": stream.partial(),
	})
}

// appendThinking adds thinking to the current thinking block.
func (stream *controlledStream) appendThinking(text string) {
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "thinking" {
		stream.startThinking(len(stream.message.Content))
		index = len(stream.message.Content) - 1
	}
	stream.appendThinkingAt(index, text)
}

// appendThinkingAt adds thinking to one thinking block.
func (stream *controlledStream) appendThinkingAt(index int, text string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	block := &stream.message.Content[index]
	block.Thinking += text
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
	})
}

// startThinking opens one thinking block.
func (stream *controlledStream) startThinking(index int) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "thinking"}
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_start", "contentIndex": index, "partial": stream.partial(),
	})
}

// startRedactedThinking opens one redacted reasoning block.
//
// The opaque payload belongs to the provider: it is kept as it is, so the block can
// be handed back unchanged on a later turn. A redacted block carries no readable
// reasoning, only the proof that there was one.
func (stream *controlledStream) startRedactedThinking(index int, data string) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	redacted := true
	stream.message.Content[index] = AssistantContentBlock{Type: "thinking", ThinkingSignature: &data, Redacted: &redacted}
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_start", "contentIndex": index, "partial": stream.partial(),
	})
}

// appendThinkingSignature adds the provider's signature to one reasoning block.
//
// The signature is what makes the reasoning verifiable for the provider. A reasoning
// block that comes back without it is a block the provider cannot accept, and one
// that was never signed is reasoning the model cannot read back either.
func (stream *controlledStream) appendThinkingSignature(index int, signature string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	block := &stream.message.Content[index]
	if block.Type != "thinking" {
		return
	}
	block.ThinkingSignature = &signature
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_delta", "contentIndex": index, "delta": "", "partial": stream.partial(),
	})
}

// markReasoningField records the field the provider read its reasoning from.
//
// The OpenCode Go gateway answers with its reasoning under `reasoning` and reads it
// back under `reasoning_content`, so the field the answer came from is not always
// the field the answer goes back into.
func (stream *controlledStream) markReasoningField(field string) {
	if stream.candidate.Provider == "opencode-go" && field == "reasoning" {
		field = "reasoning_content"
	}
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "thinking" {
		return
	}
	stream.message.Content[index].ThinkingSignature = &field
}

// startToolCall opens one tool call block of an OpenAI answer.
//
// The provider's index names the call inside the call list, not the place of the
// call in the turn: a turn that reasons before it calls a tool carries the
// reasoning in the first block and the call in the second. The call keeps the
// block the turn gave it, so the reasoning before it survives.
func (stream *controlledStream) startToolCall(index int, id string, name string) {
	block := len(stream.message.Content)
	stream.message.Content = append(stream.message.Content, AssistantContentBlock{Type: "toolCall", Id: id, Name: name, Arguments: map[string]any{}})
	stream.toolCalls[index] = &controlledToolCall{id: id, name: name}
	stream.toolCallBlocks[index] = block
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_start", "contentIndex": block, "partial": stream.partial(),
	})
}

// startAnthropicToolCall opens one tool call block of an Anthropic answer.
//
// Anthropic names the place of the block in the turn, so its index is the index.
func (stream *controlledStream) startAnthropicToolCall(index int, id string, name string) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "toolCall", Id: id, Name: name, Arguments: map[string]any{}}
	stream.toolCalls[index] = &controlledToolCall{id: id, name: name}
	stream.toolCallBlocks[index] = index
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_start", "contentIndex": index, "partial": stream.partial(),
	})
}

// appendToolCall reads one OpenAI tool-call delta.
func (stream *controlledStream) appendToolCall(index int, entry map[string]any) {
	call, ok := stream.toolCalls[index]
	if !ok {
		id, _ := entry["id"].(string)
		function, _ := entry["function"].(map[string]any)
		name, _ := function["name"].(string)
		stream.startToolCall(index, id, name)
		call = stream.toolCalls[index]
	}
	function, ok := entry["function"].(map[string]any)
	if !ok {
		return
	}
	if name, ok := function["name"].(string); ok && name != "" {
		call.name = name
	}
	if arguments, ok := function["arguments"].(string); ok && arguments != "" {
		stream.appendToolArguments(index, arguments)
	}
}

// appendToolArguments adds raw JSON arguments to one tool call.
func (stream *controlledStream) appendToolArguments(index int, text string) {
	call, ok := stream.toolCalls[index]
	if !ok {
		stream.startToolCall(index, "", "")
		call = stream.toolCalls[index]
	}
	call.arguments.WriteString(text)
	block, known := stream.toolCallBlocks[index]
	if !known {
		return
	}
	stream.message.Content[block].Arguments = controlledToolArguments(call.arguments.String())
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_delta", "contentIndex": block, "delta": text, "partial": stream.partial(),
	})
}

// appendAnthropicToolArguments adds raw JSON arguments to one Anthropic tool call.
func (stream *controlledStream) appendAnthropicToolArguments(index int, text string) {
	block, known := stream.toolCallBlocks[index]
	if !known {
		return
	}
	call, ok := stream.toolCalls[index]
	if !ok {
		call = &controlledToolCall{}
		stream.toolCalls[index] = call
	}
	call.arguments.WriteString(text)
	stream.message.Content[block].Arguments = controlledToolArguments(call.arguments.String())
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_delta", "contentIndex": block, "delta": text, "partial": stream.partial(),
	})
}

// controlledToolArguments parses the raw JSON arguments one tool call carries.
func controlledToolArguments(text string) map[string]any {
	value := ParseStreamingJSON(text)
	arguments, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return arguments
}
