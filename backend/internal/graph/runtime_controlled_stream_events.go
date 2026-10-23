package graph

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

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
