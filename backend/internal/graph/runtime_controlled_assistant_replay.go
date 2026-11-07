package graph

import "strings"

var controlledReasoningFields = map[string]bool{
	"reasoning": true, "reasoning_content": true, "reasoning_text": true,
}

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
