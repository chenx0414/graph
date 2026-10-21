package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Host side: turn one assistant stream into compact, replayable frames.
//
// Every `AssistantMessageEvent` carries `partial`, which is the *shared live*
// message object, not an event-time snapshot. Sending the raw event list across
// the worker channel therefore repeats the whole response once per delta - a
// quadratic payload that eventually makes JSON.stringify throw
// "Invalid string length" and kills the daemon. The frames keep only the block
// offsets and deltas needed to rebuild the same live stream.

// AssistantUsageCost is the money one assistant response cost.
type AssistantUsageCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// AssistantUsage is the token accounting one assistant response carries.
type AssistantUsage struct {
	Input        int64              `json:"input"`
	Output       int64              `json:"output"`
	CacheRead    int64              `json:"cacheRead"`
	CacheWrite   int64              `json:"cacheWrite"`
	CacheWrite1h *int64             `json:"cacheWrite1h,omitempty"`
	Reasoning    *int64             `json:"reasoning,omitempty"`
	TotalTokens  int64              `json:"totalTokens"`
	Cost         AssistantUsageCost `json:"cost"`
}

// AssistantContentBlock is one block of an assistant message: text, thinking or a tool call.
type AssistantContentBlock struct {
	Type              string  `json:"type"`
	Text              string  `json:"text,omitempty"`
	TextSignature     *string `json:"textSignature,omitempty"`
	Thinking          string  `json:"thinking,omitempty"`
	ThinkingSignature *string `json:"thinkingSignature,omitempty"`
	Redacted          *bool   `json:"redacted,omitempty"`
	Id                string  `json:"id,omitempty"`
	Name              string  `json:"name,omitempty"`
	// Arguments is the tool call's argument value. It is not typed as an object
	// because a model may send a call whose arguments are not an object at all:
	// the SDK's validator names that mistake ("root: must be object") and
	// shows what it received, and the runtime must not rewrite the mistake
	// into an empty object before the validator ever sees it.
	Arguments        any     `json:"arguments,omitempty"`
	ThoughtSignature *string `json:"thoughtSignature,omitempty"`
	Namespace        *string `json:"namespace,omitempty"`
}

// MarshalJSON writes one content block.
//
// A tool call always carries its arguments. The SDK validates a call against
// the tool's schema and reads a missing value as a malformed call, so an
// empty argument set - a tool that takes no parameters - must still travel
// as `{}`. `omitempty` would drop exactly that, and the worker would see no
// arguments at all. The other block kinds carry no arguments, so the shared
// field stays out of their JSON.
func (block AssistantContentBlock) MarshalJSON() ([]byte, error) {
	type alias AssistantContentBlock
	shadow := struct {
		alias
		Arguments any `json:"arguments,omitempty"`
	}{alias: alias(block)}
	if block.Type == "toolCall" {
		shadow.Arguments = assistantToolCallArguments(block.Arguments)
	}
	return json.Marshal(shadow)
}

// AssistantToolCall is one tool call an assistant message carries.
type AssistantToolCall struct {
	Type             string  `json:"type"`
	Id               string  `json:"id"`
	Name             string  `json:"name"`
	Arguments        any     `json:"arguments"`
	ThoughtSignature *string `json:"thoughtSignature,omitempty"`
	Namespace        *string `json:"namespace,omitempty"`
}

// AssistantMessage is the live assistant response the frames rebuild.
type AssistantMessage struct {
	Role                  string                  `json:"role"`
	Content               []AssistantContentBlock `json:"content"`
	Api                   string                  `json:"api"`
	Provider              string                  `json:"provider"`
	Model                 string                  `json:"model"`
	ResponseModel         *string                 `json:"responseModel,omitempty"`
	ResponseId            *string                 `json:"responseId,omitempty"`
	ProviderThinkingLevel *string                 `json:"providerThinkingLevel,omitempty"`
	Diagnostics           []any                   `json:"diagnostics,omitempty"`
	Usage                 AssistantUsage          `json:"usage"`
	StopReason            string                  `json:"stopReason"`
	ErrorMessage          *string                 `json:"errorMessage,omitempty"`
	RawStopReason         *string                 `json:"rawStopReason,omitempty"`
	EndTurn               *bool                   `json:"endTurn,omitempty"`
	Timestamp             int64                   `json:"timestamp"`
}

// AssistantMessageEvent is one event of an assistant stream.
type AssistantMessageEvent struct {
	Type         string             `json:"type"`
	ContentIndex *int               `json:"contentIndex,omitempty"`
	Delta        *string            `json:"delta,omitempty"`
	Content      *string            `json:"content,omitempty"`
	Partial      *AssistantMessage  `json:"partial,omitempty"`
	ToolCall     *AssistantToolCall `json:"toolCall,omitempty"`
	Reason       *string            `json:"reason,omitempty"`
	Message      *AssistantMessage  `json:"message,omitempty"`
	Error        *AssistantMessage  `json:"error,omitempty"`
}

// AssistantMessageFrame is one compact, replayable assistant-message progress frame.
// Terminal settlement is intentionally excluded and must be persisted separately.
type AssistantMessageFrame struct {
	Type              string             `json:"type"`
	ContentIndex      *int               `json:"contentIndex,omitempty"`
	Partial           *AssistantMessage  `json:"partial,omitempty"`
	Content           any                `json:"content,omitempty"`
	Delta             *string            `json:"delta,omitempty"`
	TextSignature     *string            `json:"textSignature,omitempty"`
	ThinkingSignature *string            `json:"thinkingSignature,omitempty"`
	Redacted          *bool              `json:"redacted,omitempty"`
	ToolCall          *AssistantToolCall `json:"toolCall,omitempty"`
	Json              *string            `json:"json,omitempty"`
	Id                *string            `json:"id,omitempty"`
	Name              *string            `json:"name,omitempty"`
	Arguments         any                `json:"arguments,omitempty"`
	ThoughtSignature  *string            `json:"thoughtSignature,omitempty"`
	Namespace         *string            `json:"namespace,omitempty"`
}

// assistantFrameBlock is the encoder's per-block bookkeeping.
type assistantFrameBlock struct {
	kind              string
	coveredChars      int
	deltaChars        int
	caughtUp          bool
	catchupJson       string
	snapshotArguments string
}

// assistantMessageFrameEncoder encodes one assistant stream. `partial` remains a shared live
// accumulator; the encoder uses per-block offsets to avoid replaying deltas already visible
// when an older queued event is consumed.
type assistantMessageFrameEncoder struct {
	started  bool
	terminal bool
	blocks   map[int]*assistantFrameBlock
}

func newAssistantMessageFrameEncoder() *assistantMessageFrameEncoder {
	return &assistantMessageFrameEncoder{blocks: map[int]*assistantFrameBlock{}}
}

// EncodeAssistantStream turns one assistant stream into compact, replayable frames.
func EncodeAssistantStream(stream ModelEventStream) []AssistantMessageFrame {
	encoder := newAssistantMessageFrameEncoder()
	frames := []AssistantMessageFrame{}
	for {
		event, ok := stream.Next()
		if !ok {
			break
		}
		decoded, err := decodeAssistantMessageEvent(event)
		if err != nil {
			panic(err)
		}
		frame := encoder.encode(decoded)
		if frame != nil {
			frames = append(frames, *frame)
		}
	}
	return frames
}

// decodeAssistantMessageEvent reads one event of the shared map shape the runtime uses.
func decodeAssistantMessageEvent(event map[string]any) (AssistantMessageEvent, error) {
	raw, err := json.Marshal(event)
	if err != nil {
		return AssistantMessageEvent{}, err
	}
	var decoded AssistantMessageEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return AssistantMessageEvent{}, err
	}
	return decoded, nil
}

// encode turns one event into one frame, or nothing when the event carries no new bytes.
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
			// Legacy grammar calls include the initial input in toolcall_start, but their
			// JSON delta stream still begins at an empty input. Its parsed arguments can
			// therefore extend, rather than exactly reproduce, the start snapshot.
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
			// The arguments value is never absent: a call that takes no
			// parameters still travels as `{}`.
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

// startBlock records that a content block began.
func (encoder *assistantMessageFrameEncoder) startBlock(contentIndex int, state *assistantFrameBlock) {
	if contentIndex < 0 {
		panic(fmt.Errorf("Invalid assistant message frame contentIndex: %d", contentIndex))
	}
	if _, exists := encoder.blocks[contentIndex]; exists {
		panic(fmt.Errorf("Assistant message block %d starts more than once", contentIndex))
	}
	encoder.blocks[contentIndex] = state
}

// block returns the bookkeeping of one open content block.
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

// endBlock closes one content block.
func (encoder *assistantMessageFrameEncoder) endBlock(contentIndex int, kind string) {
	encoder.block(contentIndex, kind)
	delete(encoder.blocks, contentIndex)
}

// encodeTextDelta keeps only the bytes the live message does not show yet.
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

// eventIndex reads the content index of one event.
func eventIndex(event AssistantMessageEvent) int {
	if event.ContentIndex == nil {
		return 0
	}
	return *event.ContentIndex
}

// assistantEventBlock reads the live content block one event points at.
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

// assistantEventText reads the authoritative text one end event carries.
func assistantEventText(event AssistantMessageEvent) string {
	if event.Content == nil {
		return ""
	}
	return *event.Content
}

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
		Arguments: assistantToolCallArguments(block.Arguments),
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

// cloneAssistantArguments copies one tool-call argument value. A value that is
// not an object is kept as it is: rewriting it would hide the model's mistake
// from the validator that is meant to name it.
func cloneAssistantArguments(arguments any) any {
	typed, ok := arguments.(map[string]any)
	if !ok {
		return arguments
	}
	clone := make(map[string]any, len(typed))
	for key, value := range typed {
		clone[key] = value
	}
	return clone
}

// assistantToolCallArguments is the argument value one tool call carries. A
// tool call always has one: an empty object when the call carries none.
func assistantToolCallArguments(arguments any) any {
	if arguments == nil {
		return map[string]any{}
	}
	return cloneAssistantArguments(arguments)
}

// assistantSerializedArguments serializes tool-call arguments.
func assistantSerializedArguments(arguments any) string {
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
func assistantParsedToolArguments(text string) any {
	return ParseStreamingJSON(text)
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

// ReplayAssistantStream rebuilds the live events from compact frames.
//
// Worker side: the frames carry only the block offsets and deltas, so the live message is
// rebuilt exactly like a provider stream built it. Frames never carry terminal settlement;
// it is passed separately so the caller can persist it.
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
	// Tool-call arguments stream as raw JSON text, so the replay accumulates the
	// same text instead of re-serializing partially parsed arguments.
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
			// The argument value travels as it is: a call whose arguments
			// are not an object must reach the validator unchanged, so the
			// validator can name the mistake.
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

// assistantTerminalEvent is the event the settlement produces.
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

// assistantFrameText reads the authoritative text one end frame carries.
func assistantFrameText(frame AssistantMessageFrame) string {
	if text, ok := frame.Content.(string); ok {
		return text
	}
	return ""
}

// capabilityFrameTextPointer reads the authoritative text one end frame carries.
func capabilityFrameTextPointer(frame AssistantMessageFrame) *string {
	text := assistantFrameText(frame)
	return &text
}

// assistantFrameTextBlock reads the text block one start frame carries.
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

// assistantFrameThinkingBlock reads the thinking block one start frame carries.
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

// assistantFrameContentBlock reads the content block one start frame carries. A frame that
// travelled over the worker channel carries a plain JSON object.
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

// setAssistantContent writes one content block at its index.
func setAssistantContent(message *AssistantMessage, index int, block AssistantContentBlock) {
	if index < 0 {
		panic(fmt.Errorf("Assistant frames reference missing content block %d", index))
	}
	for len(message.Content) <= index {
		message.Content = append(message.Content, AssistantContentBlock{})
	}
	message.Content[index] = block
}

// assistantFrameToolCallBlock reads the tool call one start frame carries.
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

// cloneAssistantMessage copies one live message so a replayed event keeps its own state.
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

// ParseStreamingJSON parses a possibly incomplete JSON document. It always returns a valid
// object, even when the JSON is incomplete.
//
// TODO(port): the Pi SDK uses the `partial-json` package. This port repairs the text and
// closes the open containers, which agrees with that package for the object and array
// prefixes a tool-call argument stream produces.
func ParseStreamingJSON(text string) any {
	if strings.TrimSpace(text) == "" {
		return map[string]any{}
	}
	if value, ok := decodeJSONValue(text); ok {
		return value
	}
	repaired := repairStreamingJSON(text)
	if value, ok := decodeJSONValue(repaired); ok {
		return value
	}
	if value, ok := partialJSONValue(repaired); ok {
		return value
	}
	return map[string]any{}
}

// decodeJSONValue reads one complete JSON document.
func decodeJSONValue(text string) (any, bool) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, false
	}
	return value, true
}

// validJSONEscapes are the escape sequences a JSON string may carry.
var validJSONEscapes = map[rune]bool{
	'"': true, '\\': true, '/': true, 'b': true, 'f': true, 'n': true, 'r': true, 't': true, 'u': true,
}

// unicodeEscapePattern matches the four hex digits of a unicode escape.
var unicodeEscapePattern = regexp.MustCompile(`^[0-9a-fA-F]{4}$`)

// repairStreamingJSON repairs malformed JSON string literals by escaping raw control
// characters inside strings and doubling backslashes before invalid escape characters.
func repairStreamingJSON(text string) string {
	var b strings.Builder
	runes := []rune(text)
	inString := false
	for index := 0; index < len(runes); index++ {
		character := runes[index]
		if !inString {
			b.WriteRune(character)
			if character == '"' {
				inString = true
			}
			continue
		}
		if character == '"' {
			b.WriteRune(character)
			inString = false
			continue
		}
		if character == '\\' {
			if index+1 >= len(runes) {
				b.WriteString("\\\\")
				continue
			}
			next := runes[index+1]
			if next == 'u' {
				if index+5 < len(runes) {
					digits := string(runes[index+2 : index+6])
					if unicodeEscapePattern.MatchString(digits) {
						b.WriteString("\\u")
						b.WriteString(digits)
						index += 5
						continue
					}
				}
			}
			if validJSONEscapes[next] {
				b.WriteRune('\\')
				b.WriteRune(next)
				index++
				continue
			}
			b.WriteString("\\\\")
			continue
		}
		if isControlCharacter(character) {
			b.WriteString(escapeControlCharacter(character))
			continue
		}
		b.WriteRune(character)
	}
	return b.String()
}

// isControlCharacter reports whether the rune is a raw control character.
func isControlCharacter(character rune) bool {
	return character >= 0x00 && character <= 0x1f
}

// escapeControlCharacter writes the escape sequence of one control character.
func escapeControlCharacter(character rune) string {
	switch character {
	case '\b':
		return "\\b"
	case '\f':
		return "\\f"
	case '\n':
		return "\\n"
	case '\r':
		return "\\r"
	case '\t':
		return "\\t"
	}
	return fmt.Sprintf("\\u%04x", character)
}

// jsonScanState is what a JSON prefix scan learns about the text.
type jsonScanState struct {
	stack       []byte
	inString    bool
	stringStart int
}

// scanJSONPrefix walks the text and reports the open containers and the string state.
func scanJSONPrefix(text string) jsonScanState {
	state := jsonScanState{}
	for index := 0; index < len(text); index++ {
		character := text[index]
		if state.inString {
			if character == '\\' {
				index++
				continue
			}
			if character == '"' {
				state.inString = false
			}
			continue
		}
		switch character {
		case '"':
			state.inString = true
			state.stringStart = index
		case '{':
			state.stack = append(state.stack, '{')
		case '[':
			state.stack = append(state.stack, '[')
		case '}', ']':
			if len(state.stack) > 0 {
				state.stack = state.stack[:len(state.stack)-1]
			}
		}
	}
	return state
}

// partialJSONValue reads the value a partial JSON document already carries.
func partialJSONValue(text string) (any, bool) {
	base := strings.TrimRight(text, " \t\r\n")
	for _, candidate := range partialJSONCandidates(base) {
		closed, ok := closeJSONContainers(candidate)
		if !ok {
			continue
		}
		var value any
		if err := json.Unmarshal([]byte(closed), &value); err != nil {
			continue
		}
		return value, true
	}
	return nil, false
}

// partialJSONCandidates are the prefixes that may still become valid JSON.
func partialJSONCandidates(base string) []string {
	candidates := []string{base}
	state := scanJSONPrefix(base)
	if state.inString {
		candidates = append(candidates, base+`"`)
		candidates = append(candidates, dropTrailingString(base, state.stringStart))
	}
	trimmed := strings.TrimRight(base, " \t\r\n")
	if strings.HasSuffix(trimmed, ":") {
		without := strings.TrimRight(trimmed[:len(trimmed)-1], " \t\r\n")
		candidates = append(candidates, without)
		if start, ok := lastStringStart(without); ok {
			candidates = append(candidates, dropTrailingString(without, start))
		}
	}
	if strings.HasSuffix(trimmed, ",") {
		candidates = append(candidates, strings.TrimRight(trimmed[:len(trimmed)-1], " \t\r\n"))
	}
	return candidates
}

// dropTrailingString removes the string that starts at the given index.
func dropTrailingString(text string, start int) string {
	trimmed := strings.TrimRight(text[:start], " \t\r\n")
	if strings.HasSuffix(trimmed, ",") {
		trimmed = strings.TrimRight(trimmed[:len(trimmed)-1], " \t\r\n")
	}
	return trimmed
}

// lastStringStart finds where the last complete string of the text starts.
func lastStringStart(text string) (int, bool) {
	for index := len(text) - 1; index >= 0; index-- {
		if text[index] != '"' {
			continue
		}
		backslashes := 0
		for cursor := index - 1; cursor >= 0 && text[cursor] == '\\'; cursor-- {
			backslashes++
		}
		if backslashes%2 != 0 {
			continue
		}
		start := index
		for start > 0 {
			previous := start - 1
			backslashes := 0
			for cursor := previous - 1; cursor >= 0 && text[cursor] == '\\'; cursor-- {
				backslashes++
			}
			if backslashes%2 != 0 {
				break
			}
			if text[previous] != '"' {
				break
			}
			start = previous
		}
		return start, true
	}
	return 0, false
}

// closeJSONContainers closes the containers the text left open.
func closeJSONContainers(text string) (string, bool) {
	state := scanJSONPrefix(text)
	closed := text
	for index := len(state.stack) - 1; index >= 0; index-- {
		if state.stack[index] == '{' {
			closed += "}"
			continue
		}
		closed += "]"
	}
	return closed, true
}
