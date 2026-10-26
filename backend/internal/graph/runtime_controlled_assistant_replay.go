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
