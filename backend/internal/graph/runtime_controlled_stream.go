package graph

import (
	"encoding/json"
	"errors"
	"strings"
)

// ControlledTextFromContent reads the text one content part carries.
func ControlledTextFromContent(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		var b strings.Builder
		for _, item := range typed {
			b.WriteString(ControlledTextFromContent(item))
		}
		return b.String()
	case map[string]any:
		if text, ok := typed["text"].(string); ok {
			return text
		}
		if thinking, ok := typed["thinking"].(string); ok {
			return thinking
		}
		if partial, ok := typed["partial_json"].(string); ok {
			return partial
		}
		if input, present := typed["input"]; present {
			encoded, err := json.Marshal(input)
			if err != nil {
				return ""
			}
			return string(encoded)
		}
		if content, ok := typed["content"].(string); ok {
			return content
		}
	}
	return ""
}

// ControlledOpenAIStream is the controlled lower-level adapter, verified for the OpenAI
// chat-completions, OpenAI Responses and Anthropic messages streams.
//
// The provider HTTP API is the boundary: the Pi SDK is not linked here, so the request is built
// and the event stream is parsed by this adapter.
//
// The candidate is the Graph model entry this send belongs to. The credential and the slot are
// resolved against it, never against the provider-shaped model the SDK carries: that one names
// the provider model, so a lookup by it would miss the configured entry and its credential.
func ControlledOpenAIStream(broker SendGate, candidate ModelEntry, resolveKey func(candidate ModelEntry) string, slot func(candidate ModelEntry) *piAdapterSlot, api ModelApi, usageOptions PiAdapterStreamOptions) PromptStreamFunc {
	if api != "openai-completions" && api != "anthropic-messages" && api != "openai-responses" {
		panic(errors.New("Unverified model transport"))
	}
	return func(model any, context map[string]any, options map[string]any) (ModelEventStream, error) {
		record := asMap(model)
		if headers := ModelRequestHeaders(candidate); headers != nil {
			record["headers"] = headers
		}
		stream := &controlledStream{
			broker: broker, candidate: candidate, resolveKey: resolveKey, slot: slot, api: api, usageOptions: usageOptions,
			// The transcript is the only provider-facing shape: the plain system prompt
			// field and the plain tool list are folded into the leading system message
			// first, the way the SDK's normalizeContext does it.
			model: record, context: controlledNormalizeContext(context), options: options,
			toolCalls: map[int]*controlledToolCall{}, toolCallBlocks: map[int]int{},
		}
		return stream, nil
	}
}
