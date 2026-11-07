package graph

import (
	"errors"
	"fmt"
)

func (encoder *assistantMessageFrameEncoder) encode(event AssistantMessageEvent) *AssistantMessageFrame {
	if encoder.terminal {
		panic(errors.New("Assistant message event " + event.Type + " follows a terminal event"))
	}
	switch event.Type {
	case "start":
		if encoder.started {
			panic(errors.New("Assistant message stream contains more than one start event"))
		}
		encoder.started = true
		partial := cloneAssistantStartMessage(event.Partial)
		return &AssistantMessageFrame{Type: "start", Partial: partial}
	case "done":
		if !encoder.started {
			panic(errors.New("Assistant message done event appears before start"))
		}
		encoder.terminal = true
		return nil
	case "error":
		encoder.terminal = true
		return nil
	}
	if !encoder.started {
		panic(errors.New("Assistant message " + event.Type + " event appears before start"))
	}
	switch event.Type {
	case "text_start":
		content := assistantEventBlock(event, event.Type)
		if content.Type != "text" {
			panic(fmt.Errorf("text_start event points to %s block at index %d", content.Type, eventIndex(event)))
		}
		encoder.startBlock(eventIndex(event), &assistantFrameBlock{kind: "text", coveredChars: len([]rune(content.Text)), deltaChars: 0})
		return &AssistantMessageFrame{Type: "text_start", ContentIndex: event.ContentIndex, Content: cloneAssistantTextBlock(content)}
	case "text_delta":
		return encoder.encodeTextDelta(event, "text")
	case "text_end":
		content := assistantEventBlock(event, event.Type)
		if content.Type != "text" {
			panic(fmt.Errorf("text_end event points to %s block at index %d", content.Type, eventIndex(event)))
		}
		encoder.endBlock(eventIndex(event), "text")
		frame := &AssistantMessageFrame{Type: "text_end", ContentIndex: event.ContentIndex, Content: assistantEventText(event)}
		if content.TextSignature != nil {
			signature := *content.TextSignature
			frame.TextSignature = &signature
		}
		return frame
	case "thinking_start":
		content := assistantEventBlock(event, event.Type)
		if content.Type != "thinking" {
			panic(fmt.Errorf("thinking_start event points to %s block at index %d", content.Type, eventIndex(event)))
		}
		encoder.startBlock(eventIndex(event), &assistantFrameBlock{kind: "thinking", coveredChars: len([]rune(content.Thinking)), deltaChars: 0})
		return &AssistantMessageFrame{Type: "thinking_start", ContentIndex: event.ContentIndex, Content: cloneAssistantThinkingBlock(content)}
	case "thinking_delta":
		return encoder.encodeTextDelta(event, "thinking")
	case "thinking_end":
		content := assistantEventBlock(event, event.Type)
		if content.Type != "thinking" {
			panic(fmt.Errorf("thinking_end event points to %s block at index %d", content.Type, eventIndex(event)))
		}
		encoder.endBlock(eventIndex(event), "thinking")
		frame := &AssistantMessageFrame{Type: "thinking_end", ContentIndex: event.ContentIndex, Content: assistantEventText(event)}
		if content.ThinkingSignature != nil {
			signature := *content.ThinkingSignature
			frame.ThinkingSignature = &signature
		}
		if content.Redacted != nil {
			redacted := *content.Redacted
			frame.Redacted = &redacted
		}
		return frame
	case "toolcall_start":
		content := assistantEventBlock(event, event.Type)
		if content.Type != "toolCall" {
			panic(fmt.Errorf("toolcall_start event points to %s block at index %d", content.Type, eventIndex(event)))
		}
		snapshot := assistantSerializedArguments(content.Arguments)
		caughtUp := snapshot == assistantEmptyParsedToolArguments
		snapshotArguments := snapshot
		if caughtUp {
			snapshotArguments = ""
		}
		encoder.startBlock(eventIndex(event), &assistantFrameBlock{
			kind: "toolCall", caughtUp: caughtUp, catchupJson: "",
			snapshotArguments: snapshotArguments,
		})
		return &AssistantMessageFrame{Type: "toolcall_start", ContentIndex: event.ContentIndex, ToolCall: cloneAssistantToolCall(content)}
	case "toolcall_delta":
		state := encoder.block(eventIndex(event), "toolCall")
		if state.caughtUp {
			if event.Delta == nil || *event.Delta == "" {
				return nil
			}
			delta := *event.Delta
			return &AssistantMessageFrame{Type: "toolcall_delta", ContentIndex: event.ContentIndex, Delta: &delta}
		}
		if event.Delta != nil {
			state.catchupJson += *event.Delta
		}
		arguments := assistantParsedToolArguments(state.catchupJson)
		if assistantSerializedArguments(arguments) != state.snapshotArguments {
			snapshot := assistantParsedToolArguments(state.snapshotArguments)
			if !assistantIsJsonPrefix(snapshot, arguments) {
				return nil
			}
		}
		state.caughtUp = true
		state.snapshotArguments = ""
		text := state.catchupJson
		state.catchupJson = ""
		if text == "" {
			return nil
		}
		return &AssistantMessageFrame{Type: "toolcall_checkpoint", ContentIndex: event.ContentIndex, Json: &text}
	case "toolcall_end":
		content := assistantEventBlock(event, event.Type)
		if content.Type != "toolCall" {
			panic(fmt.Errorf("toolcall_end event points to %s block at index %d", content.Type, eventIndex(event)))
		}
		if event.ToolCall == nil {
			panic(fmt.Errorf("toolcall_end event has invalid tool call at index %d", eventIndex(event)))
		}
		encoder.endBlock(eventIndex(event), "toolCall")
		frame := &AssistantMessageFrame{
			Type: "toolcall_end", ContentIndex: event.ContentIndex,
			Id: &event.ToolCall.Id, Name: &event.ToolCall.Name,
			Arguments: assistantToolCallArguments(event.ToolCall.Arguments),
		}
		if event.ToolCall.ThoughtSignature != nil {
			signature := *event.ToolCall.ThoughtSignature
			frame.ThoughtSignature = &signature
		}
		if event.ToolCall.Namespace != nil {
			namespace := *event.ToolCall.Namespace
			frame.Namespace = &namespace
		}
		return frame
	}
	return nil
}
