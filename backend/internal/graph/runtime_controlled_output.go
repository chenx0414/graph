package graph

import (
	"io"
	"net/http"
	"strings"
)

func (stream *controlledStream) fail(err error) {
	message := &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: string(stream.api), Provider: providerOf(stream.model), Model: modelIDOf(stream.model),
		StopReason: "error", ErrorMessage: stringPointer(err.Error()), Timestamp: NowMillis(),
	}
	stream.message = message
	event := map[string]any{"type": "error", "reason": "error", "error": asMap(message)}
	if stream.transport {
		event["transport"] = true
	}
	stream.events = append(stream.events, event)
}

func (stream *controlledStream) failTransport(err error) {
	if stream.message == nil || len(stream.message.Content) == 0 {
		stream.transport = true
	}
	stream.fail(err)
}

func providerOf(model map[string]any) string {
	provider, _ := model["provider"].(string)
	return provider
}

func modelIDOf(model map[string]any) string {
	id, _ := model["id"].(string)
	return id
}

func assistantUsageOf(usage *TokenUsage) AssistantUsage {
	if usage == nil {
		return AssistantUsage{}
	}
	return AssistantUsage{
		Input: usage.Input, Output: usage.Output, CacheRead: usage.CacheRead, CacheWrite: usage.CacheWrite,
		TotalTokens: usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite,
	}
}

func (stream *controlledStream) estimateUsage(response *http.Response) *TokenUsage {
	if response == nil || response.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8_000_001))
	if err != nil {
		return nil
	}
	output := controlledEstimateTokens(string(body))
	input := controlledEstimateTokens(controlledContextText(stream.context))
	if input <= 0 && output <= 0 {
		return nil
	}
	return &TokenUsage{Input: int64(input), Output: int64(output), UsageSource: stringPointer(string(UsageEstimated))}
}

func controlledEstimateTokens(text string) int {
	if text == "" {
		return 0
	}
	return (len(text) + 3) / 4
}

func controlledContextText(context map[string]any) string {
	var b strings.Builder
	for _, item := range controlledContextMessages(context) {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		b.WriteString(ControlledTextFromContent(message["content"]))
		b.WriteString("\n")
	}
	return b.String()
}

func (stream *controlledStream) settle(usage *TokenUsage) {
	if stream.settled {
		return
	}
	stream.settled = true
	if stream.invocation == "" {
		return
	}
	if usage != nil && usage.Output > 0 && stream.firstDeltaAt > 0 && stream.lastDeltaAt >= stream.firstDeltaAt {
		decode := stream.lastDeltaAt - stream.firstDeltaAt
		usage.DurationMs = &decode
	}
	stream.broker.Settle(stream.invocation, usage)
}

func (stream *controlledStream) handleEvent(event map[string]any) {
	switch stream.api {
	case "anthropic-messages":
		stream.handleAnthropicEvent(event)
	case "openai-responses":
		stream.handleResponsesEvent(event)
	default:
		stream.handleOpenAIEvent(event)
	}
}

func (stream *controlledStream) handleOpenAIEvent(event map[string]any) {
	choices, _ := event["choices"].([]any)
	for _, item := range choices {
		choice, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if reason, ok := choice["finish_reason"].(string); ok && reason != "" {
			stream.finishReason = controlledOpenAIStopReason(reason)
		}
		delta, ok := choice["delta"].(map[string]any)
		if !ok {
			continue
		}
		if text, ok := delta["content"].(string); ok && text != "" {
			stream.appendText(text)
		}
		if field, thinking := controlledOpenAIReasoningDelta(delta); thinking != "" {
			stream.appendThinking(thinking)
			stream.markReasoningField(field)
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, call := range calls {
			entry, ok := call.(map[string]any)
			if !ok {
				continue
			}
			index := 0
			if number, ok := controlledSafeCount(entry["index"]); ok {
				index = int(number)
			}
			stream.appendToolCall(index, entry)
		}
	}
}

func controlledOpenAIStopReason(reason string) string {
	switch reason {
	case "stop":
		return "stop"
	case "length":
		return "length"
	case "tool_calls", "function_call":
		return "toolUse"
	}
	return "stop"
}

func (stream *controlledStream) handleAnthropicEvent(event map[string]any) {
	kind, _ := event["type"].(string)
	index := 0
	if number, ok := controlledSafeCount(event["index"]); ok {
		index = int(number)
	}
	switch kind {
	case "content_block_start":
		block, _ := event["content_block"].(map[string]any)
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			stream.startText(index)
		case "thinking":
			stream.startThinking(index)
		case "redacted_thinking":
			data, _ := block["data"].(string)
			stream.startRedactedThinking(index, data)
		case "tool_use":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			stream.startAnthropicToolCall(index, id, name)
		}
	case "content_block_delta":
		delta, _ := event["delta"].(map[string]any)
		deltaType, _ := delta["type"].(string)
		switch deltaType {
		case "text_delta":
			text, _ := delta["text"].(string)
			stream.appendTextAt(index, text)
		case "thinking_delta":
			text, _ := delta["thinking"].(string)
			stream.appendThinkingAt(index, text)
		case "signature_delta":
			signature, _ := delta["signature"].(string)
			stream.appendThinkingSignature(index, signature)
		case "input_json_delta":
			text, _ := delta["partial_json"].(string)
			stream.appendAnthropicToolArguments(index, text)
		}
	case "message_delta":
		delta, _ := event["delta"].(map[string]any)
		if reason, ok := delta["stop_reason"].(string); ok && reason != "" {
			stream.finishReason = controlledAnthropicStopReason(reason)
		}
	}
}

func controlledAnthropicStopReason(reason string) string {
	switch reason {
	case "end_turn":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "toolUse"
	}
	return "stop"
}

func (stream *controlledStream) partial() map[string]any {
	return asMap(stream.message)
}

func (stream *controlledStream) appendText(text string) {
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "text" {
		stream.startText(len(stream.message.Content))
		index = len(stream.message.Content) - 1
	}
	stream.appendTextAt(index, text)
}

func (stream *controlledStream) appendTextAt(index int, text string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	stream.markDelta()
	block := &stream.message.Content[index]
	block.Text += text
	stream.events = append(stream.events, map[string]any{
		"type": "text_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
	})
}

func (stream *controlledStream) startText(index int) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "text"}
	stream.events = append(stream.events, map[string]any{
		"type": "text_start", "contentIndex": index, "partial": stream.partial(),
	})
}

func (stream *controlledStream) appendThinking(text string) {
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "thinking" {
		stream.startThinking(len(stream.message.Content))
		index = len(stream.message.Content) - 1
	}
	stream.appendThinkingAt(index, text)
}

func (stream *controlledStream) appendThinkingAt(index int, text string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	stream.markDelta()
	block := &stream.message.Content[index]
	block.Thinking += text
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
	})
}

func (stream *controlledStream) startThinking(index int) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "thinking"}
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_start", "contentIndex": index, "partial": stream.partial(),
	})
}

func (stream *controlledStream) startToolCall(index int, id string, name string) {
	block := len(stream.message.Content)
	stream.message.Content = append(stream.message.Content, AssistantContentBlock{Type: "toolCall", Id: id, Name: name, Arguments: map[string]any{}})
	stream.toolCalls[index] = &controlledToolCall{id: id, name: name}
	stream.toolCallBlocks[index] = block
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_start", "contentIndex": block, "partial": stream.partial(),
	})
}

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

func (stream *controlledStream) appendToolArguments(index int, text string) {
	stream.markDelta()
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

func controlledToolArguments(text string) any {
	return ParseStreamingJSON(text)
}
