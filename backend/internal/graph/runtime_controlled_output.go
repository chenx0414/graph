package graph

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// fail records the failure of one send as the stream's terminal event.
func (stream *controlledStream) fail(err error) {
	message := &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: string(stream.api), Provider: providerOf(stream.model), Model: modelIDOf(stream.model),
		StopReason: "error", ErrorMessage: stringPointer(err.Error()), Timestamp: NowMillis(),
	}
	stream.message = message
	stream.events = append(stream.events, map[string]any{
		"type": "error", "reason": "error", "error": asMap(message),
	})
}

// providerOf reads the provider one model names.
func providerOf(model map[string]any) string {
	provider, _ := model["provider"].(string)
	return provider
}

// modelIDOf reads the model id one model names.
func modelIDOf(model map[string]any) string {
	id, _ := model["id"].(string)
	return id
}

// readEvents reads the provider event stream.
func (stream *controlledStream) readEvents(response *http.Response) {
	defer response.Body.Close()
	stream.message = &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: string(stream.api), Provider: providerOf(stream.model), Model: modelIDOf(stream.model),
		StopReason: "pending", Timestamp: NowMillis(),
	}
	stream.events = append(stream.events, map[string]any{"type": "start", "partial": stream.partial()})
	reader := bufio.NewReader(response.Body)
	evidence := controlledUsageEvidence{}
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "data:") {
				payload := strings.TrimSpace(trimmed[5:])
				if payload == "[DONE]" {
					break
				}
				if payload != "" {
					var event map[string]any
					if json.Unmarshal([]byte(payload), &event) == nil {
						stream.handleEvent(event)
						evidence.feed(trimmed, stream.api)
					}
				}
			}
		}
		if evidence.terminal || err != nil {
			break
		}
	}
	usage := evidence.result(stream.api)
	if usage == nil {
		if stream.usageOptions.EstimateMissing {
			estimated := stream.estimateUsage(response)
			if estimated != nil {
				usage = estimated
			}
		}
	}
	if usage == nil {
		usage = &TokenUsage{UsageSource: stringPointer(string(UsageUnknown))}
	}
	stream.settle(usage)
	reason := stream.finishReason
	if reason == "" {
		reason = "stop"
	}
	stream.message.StopReason = reason
	stream.events = append(stream.events, map[string]any{
		"type": "done", "reason": reason, "message": asMap(stream.message),
	})
}

// estimateUsage estimates the usage one response used when the provider reported none.
//
// TODO(port): the Pi SDK's estimateTextTokens and estimateContextTokens are not in this module.
// The byte heuristic of the request profiler is used instead.
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

// controlledEstimateTokens estimates the tokens one text costs.
func controlledEstimateTokens(text string) int {
	if text == "" {
		return 0
	}
	return (len(text) + 3) / 4
}

// controlledContextText reads the text one context carries.
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

// settle records the usage one provider send produced.
func (stream *controlledStream) settle(usage *TokenUsage) {
	if stream.settled {
		return
	}
	stream.settled = true
	if stream.invocation == "" {
		return
	}
	stream.broker.Settle(stream.invocation, usage)
}

// handleEvent reads one provider event.
func (stream *controlledStream) handleEvent(event map[string]any) {
	switch stream.api {
	case "anthropic-messages":
		stream.handleAnthropicEvent(event)
	default:
		stream.handleOpenAIEvent(event)
	}
}

// handleOpenAIEvent reads one OpenAI chat-completions event.
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
		if thinking, ok := delta["reasoning_content"].(string); ok && thinking != "" {
			stream.appendThinking(thinking)
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

// controlledOpenAIStopReason maps one provider stop reason onto the runtime vocabulary.
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

// handleAnthropicEvent reads one Anthropic messages event.
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
		case "tool_use":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			stream.startToolCall(index, id, name)
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
		case "input_json_delta":
			text, _ := delta["partial_json"].(string)
			stream.appendToolArguments(index, text)
		}
	case "message_delta":
		delta, _ := event["delta"].(map[string]any)
		if reason, ok := delta["stop_reason"].(string); ok && reason != "" {
			stream.finishReason = controlledAnthropicStopReason(reason)
		}
	}
}

// controlledAnthropicStopReason maps one provider stop reason onto the runtime vocabulary.
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

// startToolCall opens one tool call block.
func (stream *controlledStream) startToolCall(index int, id string, name string) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "toolCall", Id: id, Name: name, Arguments: map[string]any{}}
	stream.toolCalls[index] = &controlledToolCall{id: id, name: name}
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
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	stream.message.Content[index].Arguments = controlledToolArguments(call.arguments.String())
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
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
