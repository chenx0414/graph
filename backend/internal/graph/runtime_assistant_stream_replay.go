package graph

import (
	"errors"
	"fmt"

	"encoding/json"
)

func ReplayAssistantStream(frames []AssistantMessageFrame, settlement AssistantMessage) []AssistantMessageEvent {
	var partial *AssistantMessage
	live := func() *AssistantMessage {
		if partial == nil {
			panic(errors.New("Assistant frames are missing their start frame"))
		}
		return partial
	}
	blockAt := func(index int) *AssistantContentBlock {
		message := live()
		if index < 0 || index >= len(message.Content) {
			panic(fmt.Errorf("Assistant frames reference missing content block %d", index))
		}
		return &message.Content[index]
	}
	textAt := func(index int) *AssistantContentBlock {
		block := blockAt(index)
		if block.Type != "text" {
			panic(fmt.Errorf("Assistant frames expect a text block at %d", index))
		}
		return block
	}
	thinkingAt := func(index int) *AssistantContentBlock {
		block := blockAt(index)
		if block.Type != "thinking" {
			panic(fmt.Errorf("Assistant frames expect a thinking block at %d", index))
		}
		return block
	}
	toolCallAt := func(index int) *AssistantContentBlock {
		block := blockAt(index)
		if block.Type != "toolCall" {
			panic(fmt.Errorf("Assistant frames expect a tool call at %d", index))
		}
		return block
	}
	toolJson := map[int]string{}
	events := []AssistantMessageEvent{}
	for _, frame := range frames {
		index := 0
		if frame.ContentIndex != nil {
			index = *frame.ContentIndex
		}
		switch frame.Type {
		case "start":
			if frame.Partial == nil {
				panic(errors.New("Assistant frames are missing their start frame"))
			}
			partial = cloneAssistantMessage(frame.Partial)
			events = append(events, AssistantMessageEvent{Type: "start", Partial: cloneAssistantMessage(partial)})
		case "text_start":
			setAssistantContent(live(), index, assistantFrameTextBlock(frame))
			events = append(events, AssistantMessageEvent{Type: "text_start", ContentIndex: frame.ContentIndex, Partial: cloneAssistantMessage(live())})
		case "text_delta":
			delta := ""
			if frame.Delta != nil {
				delta = *frame.Delta
			}
			textAt(index).Text += delta
			events = append(events, AssistantMessageEvent{Type: "text_delta", ContentIndex: frame.ContentIndex, Delta: frame.Delta, Partial: cloneAssistantMessage(live())})
		case "text_end":
			block := textAt(index)
			block.Text = assistantFrameText(frame)
			block.TextSignature = nil
			if frame.TextSignature != nil {
				value := *frame.TextSignature
				block.TextSignature = &value
			}
			events = append(events, AssistantMessageEvent{Type: "text_end", ContentIndex: frame.ContentIndex, Content: capabilityFrameTextPointer(frame), Partial: cloneAssistantMessage(live())})
		case "thinking_start":
			setAssistantContent(live(), index, assistantFrameThinkingBlock(frame))
			events = append(events, AssistantMessageEvent{Type: "thinking_start", ContentIndex: frame.ContentIndex, Partial: cloneAssistantMessage(live())})
		case "thinking_delta":
			delta := ""
			if frame.Delta != nil {
				delta = *frame.Delta
			}
			thinkingAt(index).Thinking += delta
			events = append(events, AssistantMessageEvent{Type: "thinking_delta", ContentIndex: frame.ContentIndex, Delta: frame.Delta, Partial: cloneAssistantMessage(live())})
		case "thinking_end":
			block := thinkingAt(index)
			block.Thinking = assistantFrameText(frame)
			block.ThinkingSignature = nil
			block.Redacted = nil
			if frame.ThinkingSignature != nil {
				value := *frame.ThinkingSignature
				block.ThinkingSignature = &value
			}
			if frame.Redacted != nil {
				value := *frame.Redacted
				block.Redacted = &value
			}
			events = append(events, AssistantMessageEvent{Type: "thinking_end", ContentIndex: frame.ContentIndex, Content: capabilityFrameTextPointer(frame), Partial: cloneAssistantMessage(live())})
		case "toolcall_start":
			setAssistantContent(live(), index, assistantFrameToolCallBlock(frame))
			toolJson[index] = ""
			events = append(events, AssistantMessageEvent{Type: "toolcall_start", ContentIndex: frame.ContentIndex, Partial: cloneAssistantMessage(live())})
		case "toolcall_checkpoint":
			text := ""
			if frame.Json != nil {
				text = *frame.Json
			}
			toolJson[index] = text
			toolCallAt(index).Arguments = assistantParsedToolArguments(text)
			empty := ""
			events = append(events, AssistantMessageEvent{Type: "toolcall_delta", ContentIndex: frame.ContentIndex, Delta: &empty, Partial: cloneAssistantMessage(live())})
		case "toolcall_delta":
			delta := ""
			if frame.Delta != nil {
				delta = *frame.Delta
			}
			next := toolJson[index] + delta
			toolJson[index] = next
			toolCallAt(index).Arguments = assistantParsedToolArguments(next)
			events = append(events, AssistantMessageEvent{Type: "toolcall_delta", ContentIndex: frame.ContentIndex, Delta: frame.Delta, Partial: cloneAssistantMessage(live())})
		case "toolcall_end":
			toolCall := AssistantToolCall{Type: "toolCall"}
			if frame.Id != nil {
				toolCall.Id = *frame.Id
			}
			if frame.Name != nil {
				toolCall.Name = *frame.Name
			}
			toolCall.Arguments = assistantToolCallArguments(frame.Arguments)
			if frame.ThoughtSignature != nil {
				value := *frame.ThoughtSignature
				toolCall.ThoughtSignature = &value
			}
			if frame.Namespace != nil {
				value := *frame.Namespace
				toolCall.Namespace = &value
			}
			setAssistantContent(live(), index, AssistantContentBlock{
				Type: "toolCall", Id: toolCall.Id, Name: toolCall.Name,
				Arguments:        assistantToolCallArguments(toolCall.Arguments),
				ThoughtSignature: toolCall.ThoughtSignature, Namespace: toolCall.Namespace,
			})
			delete(toolJson, index)
			events = append(events, AssistantMessageEvent{Type: "toolcall_end", ContentIndex: frame.ContentIndex, ToolCall: &toolCall, Partial: cloneAssistantMessage(live())})
		}
	}
	events = append(events, assistantTerminalEvent(settlement))
	return events
}

func assistantTerminalEvent(settlement AssistantMessage) AssistantMessageEvent {
	switch settlement.StopReason {
	case "error", "aborted":
		reason := settlement.StopReason
		message := settlement
		return AssistantMessageEvent{Type: "error", Reason: &reason, Error: &message}
	case "pending":
		panic(errors.New("Assistant stream settled without a terminal stop reason"))
	}
	reason := settlement.StopReason
	message := settlement
	return AssistantMessageEvent{Type: "done", Reason: &reason, Message: &message}
}

func assistantFrameText(frame AssistantMessageFrame) string {
	if text, ok := frame.Content.(string); ok {
		return text
	}
	return ""
}

func capabilityFrameTextPointer(frame AssistantMessageFrame) *string {
	text := assistantFrameText(frame)
	return &text
}

func assistantFrameTextBlock(frame AssistantMessageFrame) AssistantContentBlock {
	block := AssistantContentBlock{Type: "text"}
	if content, ok := assistantFrameContentBlock(frame); ok {
		block = content
	}
	if frame.TextSignature != nil {
		value := *frame.TextSignature
		block.TextSignature = &value
	}
	return block
}

func assistantFrameThinkingBlock(frame AssistantMessageFrame) AssistantContentBlock {
	block := AssistantContentBlock{Type: "thinking"}
	if content, ok := assistantFrameContentBlock(frame); ok {
		block = content
	}
	if frame.ThinkingSignature != nil {
		value := *frame.ThinkingSignature
		block.ThinkingSignature = &value
	}
	if frame.Redacted != nil {
		value := *frame.Redacted
		block.Redacted = &value
	}
	return block
}

func assistantFrameContentBlock(frame AssistantMessageFrame) (AssistantContentBlock, bool) {
	switch content := frame.Content.(type) {
	case AssistantContentBlock:
		return content, true
	case map[string]any:
		raw, err := json.Marshal(content)
		if err != nil {
			return AssistantContentBlock{}, false
		}
		var block AssistantContentBlock
		if err := json.Unmarshal(raw, &block); err != nil {
			return AssistantContentBlock{}, false
		}
		return block, true
	}
	return AssistantContentBlock{}, false
}

func setAssistantContent(message *AssistantMessage, index int, block AssistantContentBlock) {
	if index < 0 {
		panic(fmt.Errorf("Assistant frames reference missing content block %d", index))
	}
	for len(message.Content) <= index {
		message.Content = append(message.Content, AssistantContentBlock{})
	}
	message.Content[index] = block
}

func assistantFrameToolCallBlock(frame AssistantMessageFrame) AssistantContentBlock {
	block := AssistantContentBlock{Type: "toolCall"}
	if frame.ToolCall != nil {
		block.Id = frame.ToolCall.Id
		block.Name = frame.ToolCall.Name
		block.Arguments = assistantToolCallArguments(frame.ToolCall.Arguments)
		block.ThoughtSignature = frame.ToolCall.ThoughtSignature
		block.Namespace = frame.ToolCall.Namespace
	}
	return block
}

func cloneAssistantMessage(message *AssistantMessage) *AssistantMessage {
	if message == nil {
		return nil
	}
	clone := *message
	clone.Content = make([]AssistantContentBlock, len(message.Content))
	for index, block := range message.Content {
		copied := block
		copied.Arguments = cloneAssistantArguments(block.Arguments)
		clone.Content[index] = copied
	}
	if message.Diagnostics != nil {
		clone.Diagnostics = append([]any{}, message.Diagnostics...)
	}
	return &clone
}
