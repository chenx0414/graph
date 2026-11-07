package graph

import (
	"fmt"
)

func (encoder *assistantMessageFrameEncoder) startBlock(contentIndex int, state *assistantFrameBlock) {
	if contentIndex < 0 {
		panic(fmt.Errorf("Invalid assistant message frame contentIndex: %d", contentIndex))
	}
	if _, exists := encoder.blocks[contentIndex]; exists {
		panic(fmt.Errorf("Assistant message block %d starts more than once", contentIndex))
	}
	encoder.blocks[contentIndex] = state
}

func (encoder *assistantMessageFrameEncoder) block(contentIndex int, kind string) *assistantFrameBlock {
	if contentIndex < 0 {
		panic(fmt.Errorf("Invalid assistant message frame contentIndex: %d", contentIndex))
	}
	state, exists := encoder.blocks[contentIndex]
	if !exists {
		panic(fmt.Errorf("Assistant message %s block %d has not started", kind, contentIndex))
	}
	if state.kind != kind {
		panic(fmt.Errorf("Assistant message block %d is %s, not %s", contentIndex, state.kind, kind))
	}
	return state
}

func (encoder *assistantMessageFrameEncoder) endBlock(contentIndex int, kind string) {
	encoder.block(contentIndex, kind)
	delete(encoder.blocks, contentIndex)
}

func (encoder *assistantMessageFrameEncoder) encodeTextDelta(event AssistantMessageEvent, kind string) *AssistantMessageFrame {
	state := encoder.block(eventIndex(event), kind)
	delta := ""
	if event.Delta != nil {
		delta = *event.Delta
	}
	deltaStart := state.deltaChars
	state.deltaChars += len([]rune(delta))
	covered := state.coveredChars - deltaStart
	if covered < 0 {
		covered = 0
	}
	length := len([]rune(delta))
	if covered >= length {
		return nil
	}
	uncovered := delta
	if covered > 0 {
		runes := []rune(delta)
		uncovered = string(runes[covered:])
	}
	if kind == "text" {
		return &AssistantMessageFrame{Type: "text_delta", ContentIndex: event.ContentIndex, Delta: &uncovered}
	}
	return &AssistantMessageFrame{Type: "thinking_delta", ContentIndex: event.ContentIndex, Delta: &uncovered}
}

func eventIndex(event AssistantMessageEvent) int {
	if event.ContentIndex == nil {
		return 0
	}
	return *event.ContentIndex
}

func assistantEventBlock(event AssistantMessageEvent, frameType string) AssistantContentBlock {
	if event.ContentIndex == nil || *event.ContentIndex < 0 {
		panic(fmt.Errorf("Invalid assistant message frame contentIndex: %v", event.ContentIndex))
	}
	if event.Partial == nil {
		panic(fmt.Errorf("%s event has no content block at index %d", frameType, *event.ContentIndex))
	}
	index := *event.ContentIndex
	if index >= len(event.Partial.Content) {
		panic(fmt.Errorf("%s event has no content block at index %d", frameType, index))
	}
	return event.Partial.Content[index]
}

func assistantEventText(event AssistantMessageEvent) string {
	if event.Content == nil {
		return ""
	}
	return *event.Content
}
