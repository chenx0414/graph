package graph

import (
	"encoding/json"
	"errors"
	"strings"
)

// cloneAssistantStartMessage copies the start message with an empty content list.
func cloneAssistantStartMessage(message *AssistantMessage) *AssistantMessage {
	if message == nil {
		return &AssistantMessage{Role: "assistant", Content: []AssistantContentBlock{}}
	}
	clone := &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: message.Api, Provider: message.Provider, Model: message.Model,
		Usage: message.Usage, StopReason: "pending", Timestamp: message.Timestamp,
	}
	if message.ResponseModel != nil {
		value := *message.ResponseModel
		clone.ResponseModel = &value
	}
	if message.ResponseId != nil {
		value := *message.ResponseId
		clone.ResponseId = &value
	}
	if message.ProviderThinkingLevel != nil {
		value := *message.ProviderThinkingLevel
		clone.ProviderThinkingLevel = &value
	}
	if message.Diagnostics != nil {
		clone.Diagnostics = message.Diagnostics
	}
	return clone
}

// cloneAssistantTextBlock copies one text block.
func cloneAssistantTextBlock(block AssistantContentBlock) AssistantContentBlock {
	clone := AssistantContentBlock{Type: "text", Text: block.Text}
	if block.TextSignature != nil {
		value := *block.TextSignature
		clone.TextSignature = &value
	}
	return clone
}

// cloneAssistantThinkingBlock copies one thinking block.
func cloneAssistantThinkingBlock(block AssistantContentBlock) AssistantContentBlock {
	clone := AssistantContentBlock{Type: "thinking", Thinking: block.Thinking}
	if block.ThinkingSignature != nil {
		value := *block.ThinkingSignature
		clone.ThinkingSignature = &value
	}
	if block.Redacted != nil {
		value := *block.Redacted
		clone.Redacted = &value
	}
	return clone
}

// cloneAssistantToolCall copies one tool call.
func cloneAssistantToolCall(block AssistantContentBlock) *AssistantToolCall {
	clone := &AssistantToolCall{
		Type: "toolCall", Id: block.Id, Name: block.Name,
		Arguments: cloneAssistantArguments(block.Arguments),
	}
	if block.ThoughtSignature != nil {
		value := *block.ThoughtSignature
		clone.ThoughtSignature = &value
	}
	if block.Namespace != nil {
		value := *block.Namespace
		clone.Namespace = &value
	}
	return clone
}

// cloneAssistantArguments copies one tool-call argument object.
func cloneAssistantArguments(arguments map[string]any) map[string]any {
	if arguments == nil {
		return map[string]any{}
	}
	clone := make(map[string]any, len(arguments))
	for key, value := range arguments {
		clone[key] = value
	}
	return clone
}

// assistantSerializedArguments serializes tool-call arguments.
func assistantSerializedArguments(arguments map[string]any) string {
	if arguments == nil {
		arguments = map[string]any{}
	}
	encoded, err := json.Marshal(arguments)
	if err != nil {
		panic(errors.New("Tool-call arguments are not JSON-serializable"))
	}
	return string(encoded)
}

// assistantEmptyParsedToolArguments is what an empty argument stream parses to.
var assistantEmptyParsedToolArguments = assistantSerializedArguments(assistantParsedToolArguments(""))

// assistantParsedToolArguments parses a possibly incomplete argument stream.
func assistantParsedToolArguments(text string) map[string]any {
	value := ParseStreamingJSON(text)
	arguments, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return arguments
}

// assistantIsJsonPrefix reports whether current extends snapshot.
func assistantIsJsonPrefix(snapshot any, current any) bool {
	switch typed := snapshot.(type) {
	case string:
		text, ok := current.(string)
		return ok && strings.HasPrefix(text, typed)
	case []any:
		list, ok := current.([]any)
		if !ok || len(typed) > len(list) {
			return false
		}
		for index, value := range typed {
			if !assistantIsJsonPrefix(value, list[index]) {
				return false
			}
		}
		return true
	case map[string]any:
		if snapshot == nil {
			return current == nil
		}
		record, ok := current.(map[string]any)
		if !ok {
			return false
		}
		for key, value := range typed {
			other, present := record[key]
			if !present || !assistantIsJsonPrefix(value, other) {
				return false
			}
		}
		return true
	case nil:
		return current == nil
	}
	return snapshot == current
}
