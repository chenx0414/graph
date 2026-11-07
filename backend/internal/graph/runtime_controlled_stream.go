package graph

import (
	"encoding/json"
	"errors"
	"strings"
)

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
			model: record, context: controlledNormalizeContext(context), options: options,
			toolCalls: map[int]*controlledToolCall{}, toolCallBlocks: map[int]int{},
		}
		return stream, nil
	}
}
