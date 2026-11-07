package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/MichaelKinsy/PiG/ai"
)


type EventStream interface {
	Next() (map[string]any, bool)
	Result() map[string]any
}

type StreamFunc func(ctx context.Context, transcript []map[string]any, options map[string]any) (EventStream, error)

const MaxTokensOption = "maxTokens"

func requestOptions(bridge ProviderBridge, options ai.StreamOptions) map[string]any {
	merged := map[string]any{}
	for key, value := range bridge.Options {
		merged[key] = value
	}
	if options.MaxTokens > 0 {
		merged[MaxTokensOption] = options.MaxTokens
	}
	return merged
}

type ProviderBridge struct {
	Stream StreamFunc
	Options map[string]any
}

func BridgeAPI(bridge ProviderBridge, api ai.API) ai.ProviderAPIs {
	stream := func(ctx context.Context, model *ai.Model, request ai.TranscriptContext, options ai.StreamOptions) (*ai.AssistantMessageEventStream, error) {
		output := ai.NewAssistantMessageEventStream()
		go func() {
			transcript, err := TranscriptMessages(request)
			if err != nil {
				pushFailure(output, model, err.Error())
				return
			}
			source, err := bridge.Stream(ctx, transcript, requestOptions(bridge, options))
			if err != nil {
				pushFailure(output, model, err.Error())
				return
			}
			for {
				event, ok := source.Next()
				if !ok {
					break
				}
				converted, terminal, err := ConvertProviderEvent(event)
				if err != nil {
					pushFailure(output, model, err.Error())
					return
				}
				if converted != nil {
					if err := output.Push(converted); err != nil {
						pushFailure(output, model, err.Error())
						return
					}
				}
				if terminal {
					return
				}
			}
			pushSettlement(output, model, source.Result())
		}()
		return output, nil
	}
	return ai.ProviderAPIMap{api: &ai.ProviderStreams{Stream: stream, StreamSimple: stream}}
}

func bridgeRequestOptions(base map[string]any, options ai.StreamOptions) map[string]any {
	merged := map[string]any{}
	for key, value := range base {
		merged[key] = value
	}
	if options.MaxTokens > 0 {
		merged["maxTokens"] = options.MaxTokens
	}
	return merged
}

func TranscriptMessages(request ai.TranscriptContext) ([]map[string]any, error) {
	messages := request.Messages()
	out := make([]map[string]any, 0, len(messages))
	for index, message := range messages {
		body, err := json.Marshal(message)
		if err != nil {
			return nil, fmt.Errorf("pig kernel: transcript message %d is not serializable: %w", index, err)
		}
		decoded := map[string]any{}
		if err := json.Unmarshal(body, &decoded); err != nil {
			return nil, fmt.Errorf("pig kernel: transcript message %d is not readable: %w", index, err)
		}
		out = append(out, decoded)
	}
	return out, nil
}

func ConvertProviderEvent(event map[string]any) (ai.AssistantMessageEvent, bool, error) {
	kind, _ := event["type"].(string)
	index := 0
	if value, ok := event["contentIndex"].(int); ok {
		index = value
	}
	delta, _ := event["delta"].(string)
	content, _ := event["content"].(string)
	switch kind {
	case "start":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.StartEvent{Partial: partial}, false, nil
	case "text_start":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.TextStartEvent{ContentIndex: index, Partial: partial}, false, nil
	case "text_delta":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.TextDeltaEvent{ContentIndex: index, Delta: delta, Partial: partial}, false, nil
	case "text_end":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.TextEndEvent{ContentIndex: index, Content: content, Partial: partial}, false, nil
	case "thinking_start":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.ThinkingStartEvent{ContentIndex: index, Partial: partial}, false, nil
	case "thinking_delta":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.ThinkingDeltaEvent{ContentIndex: index, Delta: delta, Partial: partial}, false, nil
	case "thinking_end":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.ThinkingEndEvent{ContentIndex: index, Content: content, Partial: partial}, false, nil
	case "toolcall_start":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.ToolCallStartEvent{ContentIndex: index, Partial: partial}, false, nil
	case "toolcall_delta":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		return ai.ToolCallDeltaEvent{ContentIndex: index, Delta: delta, Partial: partial}, false, nil
	case "toolcall_end":
		partial, err := assistantMessage(event["partial"])
		if err != nil {
			return nil, false, err
		}
		call, err := toolCall(event["toolCall"])
		if err != nil {
			return nil, false, err
		}
		return ai.ToolCallEndEvent{ContentIndex: index, ToolCall: call, Partial: partial}, false, nil
	case "done":
		message, err := assistantMessage(event["message"])
		if err != nil {
			return nil, false, err
		}
		reason, _ := event["reason"].(string)
		return ai.DoneEvent{Reason: stopReason(reason), Message: message}, true, nil
	case "error":
		message, err := assistantMessage(event["error"])
		if err != nil {
			return nil, false, err
		}
		reason, _ := event["reason"].(string)
		if reason == "" {
			reason = "error"
		}
		return ai.ErrorEvent{Reason: stopReason(reason), Error: message}, true, nil
	}
	return nil, false, nil
}

func pushSettlement(output *ai.AssistantMessageEventStream, model *ai.Model, settlement map[string]any) {
	if settlement == nil {
		pushFailure(output, model, "The provider stream ended without a terminal event")
		return
	}
	message, err := assistantMessage(settlement)
	if err != nil {
		pushFailure(output, model, err.Error())
		return
	}
	if message.ErrorMessage != "" {
		_ = output.Push(ai.ErrorEvent{Reason: ai.StopReasonError, Error: message})
		return
	}
	_ = output.Push(ai.DoneEvent{Reason: stopReason(string(message.StopReason)), Message: message})
}

func pushFailure(output *ai.AssistantMessageEventStream, model *ai.Model, reason string) {
	message := &ai.AssistantMessage{
		Content:      []ai.AssistantContentBlock{},
		API:          model.ProviderMeta.API,
		Provider:     model.ProviderMeta.ProviderID,
		Model:        model.ID,
		StopReason:   ai.StopReasonError,
		ErrorMessage: reason,
		Timestamp:    nowMillis(),
	}
	_ = output.Push(ai.ErrorEvent{Reason: ai.StopReasonError, Error: message})
}

func assistantMessage(value any) (*ai.AssistantMessage, error) {
	if value == nil {
		return nil, fmt.Errorf("pig kernel: the provider reported no assistant message")
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("pig kernel: the assistant message is not serializable: %w", err)
	}
	message := &ai.AssistantMessage{}
	if err := json.Unmarshal(body, message); err != nil {
		return nil, fmt.Errorf("pig kernel: the assistant message is not readable: %w", err)
	}
	restoreToolCallArguments(message)
	return message, nil
}

func restoreToolCallArguments(message *ai.AssistantMessage) {
	for index, block := range message.Content {
		call, ok := block.(ai.ToolCall)
		if !ok || call.Arguments != nil {
			continue
		}
		restoreMissingArguments(&call)
		message.Content[index] = call
	}
}

func restoreMissingArguments(call *ai.ToolCall) {
	arguments, err := call.ArgumentsJSON()
	if err == nil && string(arguments) == "{}" {
		call.Arguments = ai.JsonObject{}
	}
}

func toolCall(value any) (ai.ToolCall, error) {
	call := ai.ToolCall{}
	if value == nil {
		return call, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return call, fmt.Errorf("pig kernel: the tool call is not serializable: %w", err)
	}
	if err := json.Unmarshal(body, &call); err != nil {
		return call, fmt.Errorf("pig kernel: the tool call is not readable: %w", err)
	}
	if call.Arguments == nil {
		restoreMissingArguments(&call)
	}
	return call, nil
}

func stopReason(reason string) ai.StopReason {
	switch reason {
	case "stop":
		return ai.StopReasonStop
	case "length":
		return ai.StopReasonLength
	case "toolUse":
		return ai.StopReasonToolUse
	case "deferred":
		return ai.StopReasonDeferred
	case "aborted":
		return ai.StopReasonAborted
	}
	return ai.StopReasonError
}
