package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/MichaelKinsy/PiG/ai"
)

// The provider stream the daemon owns.
//
// PiG's provider runtime accepts any stream implementation, so the daemon can
// hand the kernel its own controlled stream. The kernel therefore never owns
// an ungated provider channel, and the Graph admission rules keep their force
// over every send.
//
// The daemon/kernel division of labour is documented in docs/architecture.md,
// section daemon 与内核的分工.

// EventStream is the provider answer stream the daemon owns.
//
// It is the shape Graph's own model stream already has, so the daemon hands it
// over without a conversion.
type EventStream interface {
	// Next returns the next event of the answer, if there is one.
	Next() (map[string]any, bool)
	// Result returns the settlement of the answer.
	Result() map[string]any
}

// StreamFunc sends one transcript to the model and returns its answer stream.
type StreamFunc func(ctx context.Context, transcript []map[string]any, options map[string]any) (EventStream, error)

// ProviderBridge is the daemon's model channel, seen from the kernel.
type ProviderBridge struct {
	// Stream sends the transcript to the model the daemon chose.
	Stream StreamFunc
	// Options are the provider options the daemon's stream expects.
	Options map[string]any
}

// BridgeAPI turns the daemon's stream into the provider implementation the
// kernel generates with.
//
// The kernel asks for the model's answer; the daemon's stream is what produces
// it. The events the daemon emits are the SDK's own events, so the kernel sees
// the same live message and the same tool calls the SDK would have seen.
func BridgeAPI(bridge ProviderBridge, api ai.API) ai.ProviderAPIs {
	stream := func(ctx context.Context, model *ai.Model, request ai.TranscriptContext, options ai.StreamOptions) (*ai.AssistantMessageEventStream, error) {
		output := ai.NewAssistantMessageEventStream()
		go func() {
			transcript, err := TranscriptMessages(request)
			if err != nil {
				pushFailure(output, model, err.Error())
				return
			}
			source, err := bridge.Stream(ctx, transcript, bridge.Options)
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

// TranscriptMessages reads the kernel's transcript as the SDK's own message
// maps.
//
// The kernel keeps the transcript in PiG's message types. The daemon's stream
// reads Pi's message maps, so the transcript crosses the boundary as the JSON
// both sides already agree on: the same system message with its tool
// declarations, the same user turn, the same assistant turn and the same tool
// results.
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

// ConvertProviderEvent turns one event of the daemon's answer into the
// kernel's own event.
//
// The second answer reports whether the event ended the answer.
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

// pushSettlement ends the answer with the settlement the daemon reported.
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

// pushFailure ends the answer with an error the kernel reports to the model.
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

// assistantMessage reads one assistant message the daemon reported.
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

// restoreToolCallArguments gives every tool call of the message its arguments back.
//
// The daemon's own message shape leaves the arguments of a call with none out
// of the JSON, and the kernel reads a tool call's arguments as a JSON value: a
// missing value is the null that fails the object schema of every tool, so a
// call that asked for nothing was refused for the shape of its asking. A call
// with no arguments is a call with an empty object.
func restoreToolCallArguments(message *ai.AssistantMessage) {
	for index, block := range message.Content {
		call, ok := block.(ai.ToolCall)
		if !ok || call.Arguments != nil {
			continue
		}
		call.Arguments = ai.JsonObject{}
		message.Content[index] = call
	}
}

// toolCall reads one tool call the daemon reported.
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
		call.Arguments = ai.JsonObject{}
	}
	return call, nil
}

// stopReason reads the SDK's stop reason as the kernel's own.
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
