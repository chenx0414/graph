package graph

import (
	"net/url"
	"strings"
)

// ConversationMessage is one durable transcript row.
type ConversationMessage struct {
	Id          string         `json:"id"`
	Seq         int            `json:"seq"`
	Role        string         `json:"role"`
	Kind        string         `json:"kind"`
	Text        string         `json:"text"`
	Data        map[string]any `json:"data"`
	State       string         `json:"state"`
	OperationId *string        `json:"operationId"`
	Turn        int            `json:"turn"`
	CreatedAt   int64          `json:"createdAt"`
	UpdatedAt   int64          `json:"updatedAt"`
}

// LiveTool is one in-flight tool call.
type LiveTool struct {
	ToolCallId  string `json:"toolCallId"`
	OperationId string `json:"operationId"`
	Name        string `json:"name"`
	Summary     string `json:"summary"`
	Done        bool   `json:"done"`
	Error       bool   `json:"error"`
	Ordinal     int    `json:"ordinal"`
}

// LiveText is one streaming assistant part.
type LiveText struct {
	Attached    bool   `json:"attached,omitempty"`
	OperationId string `json:"operationId"`
	EntryId     string `json:"entryId"`
	PartId      string `json:"partId"`
	Text        string `json:"text"`
	Length      int    `json:"length"`
	UpdatedAt   int64  `json:"updatedAt"`
	Ordinal     int    `json:"ordinal"`
}

// StreamKey identifies one live text part.
func StreamKey(operationId, entryId, partId string) string {
	return operationId + "\u0000" + entryId + "\u0000" + partId
}

// ConversationProjectionState is the client-side transcript reducer.
type ConversationProjectionState struct {
	EventCursor       int
	SnapshotCursor    int
	Records           map[string]ConversationMessage
	LiveText          map[string]LiveText
	LiveTextOrder     []string
	LiveTools         map[string]LiveTool
	LiveToolsOrder    []string
	StreamNeedsResync bool
	MessageCount      int
	WindowStartSeq    *int
	WindowEndSeq      *int
	ForwardCursor     *int
	OlderExhausted    bool
	HistoryExhausted  bool
}

// ConversationProjectionEvent is one server event applied to the projection.
type ConversationProjectionEvent struct {
	Cursor *int
	Type   string
	Data   *ConversationEventData
}

// ConversationEventData is the optional payload of a projection event.
type ConversationEventData struct {
	OperationId *string
	Text        string
	HasText     bool
	EntryId     string
	PartId      string
	Ordinal     *int
	Len         *int
	Reset       bool
	Message     *ConversationMessage
	Phase       string
	ToolCallId  string
	ToolName    string
	Summary     string
	IsError     bool
}

// ConversationHistoryRequest asks for one page of older or newer rows.
type ConversationHistoryRequest struct {
	Direction string `json:"direction"`
	Cursor    int    `json:"cursor"`
}

// ConversationSnapshot is the view a client renders.
// TODO(port): live text and live tools keep insertion order. Recorded message data uses CanonicalJSON, which is content equality; TypeScript uses reference inequality.
type ConversationSnapshot struct {
	Messages          []ConversationMessage       `json:"messages"`
	QueuedMessages    []ConversationMessage       `json:"queuedMessages"`
	Streaming         []LiveText                  `json:"streaming"`
	LiveTools         []LiveTool                  `json:"liveTools"`
	PromptSuggestion  string                      `json:"promptSuggestion"`
	StreamNeedsResync bool                        `json:"streamNeedsResync"`
	HistoryRequest    *ConversationHistoryRequest `json:"historyRequest"`
}

var conversationTerminalEvents = map[string]bool{
	"operation.result": true, "operation.unknown": true, "operation.interrupted": true,
	"operation.not_sent": true, "operation.report_rejected": true, "operation.reconciled": true,
	"context.rejected": true,
}

func conversationDataEqual(left, right map[string]any) bool {
	if left == nil && right == nil {
		return true
	}
	return CanonicalJSON(left) == CanonicalJSON(right)
}

func conversationCopyMessages(current map[string]ConversationMessage) map[string]ConversationMessage {
	next := make(map[string]ConversationMessage, len(current))
	for key, value := range current {
		next[key] = value
	}
	return next
}

func mergeConversationRecords(current map[string]ConversationMessage, incoming []ConversationMessage) map[string]ConversationMessage {
	changed := false
	next := conversationCopyMessages(current)
	for _, message := range incoming {
		previous, ok := next[message.Id]
		if ok && message.UpdatedAt < previous.UpdatedAt {
			continue
		}
		if !ok || previous.Text != message.Text || previous.State != message.State || !conversationDataEqual(previous.Data, message.Data) || previous.UpdatedAt != message.UpdatedAt {
			next[message.Id] = message
			changed = true
		}
	}
	if !changed {
		return current
	}
	return next
}

func orderConversationMessages(messages []ConversationMessage) []ConversationMessage {
	ordered := []ConversationMessage{}
	for index := 0; index < len(messages); {
		if messages[index].Role != "assistant" {
			ordered = append(ordered, messages[index])
			index++
			continue
		}
		answers := []ConversationMessage{}
		tools := []ConversationMessage{}
		for index < len(messages) && (messages[index].Role == "assistant" || messages[index].Role == "tool") {
			if messages[index].Role == "assistant" {
				answers = append(answers, messages[index])
			} else {
				tools = append(tools, messages[index])
			}
			index++
		}
		ordered = append(ordered, tools...)
		ordered = append(ordered, answers...)
	}
	return ordered
}

// CreateConversationProjection returns an empty reducer.
func CreateConversationProjection() ConversationProjectionState {
	return ConversationProjectionState{
		Records: map[string]ConversationMessage{}, LiveText: map[string]LiveText{}, LiveTools: map[string]LiveTool{},
	}
}

// ConversationView is one durable window plus optional stream replacements.
type ConversationView struct {
	EventCursor  *int
	Messages     []ConversationMessage
	MessageCount int
	Streams      []LiveText
	HasStreams   bool
}

func conversationPutLive(order []string, items map[string]LiveText, key string, value LiveText) []string {
	if _, ok := items[key]; !ok {
		order = append(order, key)
	}
	items[key] = value
	return order
}

func conversationFilterText(order []string, items map[string]LiveText, keep func(LiveText) bool) ([]string, map[string]LiveText) {
	next := map[string]LiveText{}
	kept := []string{}
	for _, key := range order {
		item, ok := items[key]
		if !ok || !keep(item) {
			continue
		}
		next[key] = item
		kept = append(kept, key)
	}
	return kept, next
}

func conversationFilterTools(order []string, items map[string]LiveTool, keep func(LiveTool) bool) ([]string, map[string]LiveTool) {
	next := map[string]LiveTool{}
	kept := []string{}
	for _, key := range order {
		item, ok := items[key]
		if !ok || !keep(item) {
			continue
		}
		next[key] = item
		kept = append(kept, key)
	}
	return kept, next
}

// ObserveConversationView merges a durable window without treating it as exhaustive history.
func ObserveConversationView(state ConversationProjectionState, view ConversationView) ConversationProjectionState {
	records := mergeConversationRecords(state.Records, view.Messages)
	stale := view.EventCursor != nil && *view.EventCursor < state.EventCursor
	liveText := map[string]LiveText{}
	order := []string{}
	if stale || !view.HasStreams {
		for key, value := range state.LiveText {
			liveText[key] = value
		}
		order = append(order, state.LiveTextOrder...)
	}
	if !stale {
		for _, stream := range view.Streams {
			key := StreamKey(stream.OperationId, stream.EntryId, stream.PartId)
			previous, ok := state.LiveText[key]
			if view.EventCursor != nil || state.StreamNeedsResync || !ok || strings.HasPrefix(stream.Text, previous.Text) || stream.Length > previous.Length {
				attached := !ok
				if ok {
					attached = previous.Attached
				}
				stream.Attached = attached
				order = conversationPutLive(order, liveText, key, stream)
			} else if ok {
				order = conversationPutLive(order, liveText, key, previous)
			}
		}
	}
	eventCursor := state.EventCursor
	if eventCursor == 0 && view.EventCursor != nil {
		eventCursor = *view.EventCursor
	}
	snapshot := state.SnapshotCursor
	if view.EventCursor != nil && *view.EventCursor > snapshot {
		snapshot = *view.EventCursor
	}
	resync := state.StreamNeedsResync
	if !stale {
		resync = false
	}
	start := state.WindowStartSeq
	end := state.WindowEndSeq
	if len(view.Messages) > 0 {
		minSeq := view.Messages[0].Seq
		maxSeq := view.Messages[0].Seq
		for _, message := range view.Messages[1:] {
			if message.Seq < minSeq {
				minSeq = message.Seq
			}
			if message.Seq > maxSeq {
				maxSeq = message.Seq
			}
		}
		start = &minSeq
		end = &maxSeq
	}
	state.Records = records
	state.LiveText = liveText
	state.LiveTextOrder = order
	state.EventCursor = eventCursor
	state.SnapshotCursor = snapshot
	state.StreamNeedsResync = resync
	state.MessageCount = view.MessageCount
	state.WindowStartSeq = start
	state.WindowEndSeq = end
	return state
}

// ApplyConversationEvent folds one event when its cursor is new.
func ApplyConversationEvent(state ConversationProjectionState, event ConversationProjectionEvent) ConversationProjectionState {
	if event.Cursor != nil && *event.Cursor <= state.EventCursor {
		return state
	}
	covered := event.Type == "message.delta" && event.Cursor != nil && *event.Cursor <= state.SnapshotCursor
	next := state
	if !covered {
		next = reduceConversationEvent(state, event)
	}
	if event.Cursor == nil {
		return next
	}
	next.EventCursor = *event.Cursor
	return next
}

func reduceConversationEvent(state ConversationProjectionState, event ConversationProjectionEvent) ConversationProjectionState {
	data := event.Data
	if event.Type == "message.delta" && data != nil && data.HasText {
		operationId := "stream"
		if data.OperationId != nil {
			operationId = *data.OperationId
		}
		entryId := data.EntryId
		if entryId == "" {
			entryId = "entry"
		}
		partId := data.PartId
		if partId == "" {
			partId = "text"
		}
		key := StreamKey(operationId, entryId, partId)
		previous, ok := state.LiveText[key]
		length := 0
		if ok {
			length = previous.Length
		}
		length += utf16Len(data.Text)
		if data.Len != nil {
			length = *data.Len
		}
		if ok && data.Len != nil && *data.Len <= previous.Length && (data.Reset != true || (event.Cursor == nil && strings.HasPrefix(previous.Text, data.Text))) {
			return state
		}
		if !ok && data.Reset != true && data.Len != nil && *data.Len != utf16Len(data.Text) {
			state.StreamNeedsResync = true
			return state
		}
		reset := data.Reset || !ok
		appendable := ok && previous.Length+utf16Len(data.Text) == length
		if !reset && !appendable && data.Len != nil {
			state.StreamNeedsResync = true
			return state
		}
		ordinal := 0
		if ok {
			ordinal = previous.Ordinal
		}
		if data.Ordinal != nil {
			ordinal = *data.Ordinal
		}
		value := LiveText{OperationId: operationId, EntryId: entryId, PartId: partId, Ordinal: ordinal, Text: data.Text, Length: length, UpdatedAt: NowMillis()}
		if !reset {
			value.Text = previous.Text + data.Text
			value.Attached = previous.Attached
		}
		items := map[string]LiveText{}
		for id, item := range state.LiveText {
			items[id] = item
		}
		order := append([]string{}, state.LiveTextOrder...)
		state.LiveText = items
		state.LiveTextOrder = conversationPutLive(order, items, key, value)
		state.StreamNeedsResync = false
		return state
	}
	if event.Type == "message.tool" && data != nil && data.ToolCallId != "" {
		operationId := "stream"
		if data.OperationId != nil {
			operationId = *data.OperationId
		}
		ordinal := 0
		if data.Ordinal != nil {
			ordinal = *data.Ordinal
		}
		items := map[string]LiveTool{}
		for id, item := range state.LiveTools {
			items[id] = item
		}
		order := append([]string{}, state.LiveToolsOrder...)
		if _, ok := items[data.ToolCallId]; !ok {
			order = append(order, data.ToolCallId)
		}
		items[data.ToolCallId] = LiveTool{
			ToolCallId: data.ToolCallId, OperationId: operationId, Name: conversationDefault(data.ToolName, "tool"),
			Summary: data.Summary, Done: data.Phase == "end", Error: data.IsError, Ordinal: ordinal,
		}
		state.LiveTools = items
		state.LiveToolsOrder = order
		return state
	}
	if data != nil && data.OperationId != nil && conversationTerminalEvents[event.Type] {
		operationId := *data.OperationId
		textOrder, text := conversationFilterText(state.LiveTextOrder, state.LiveText, func(item LiveText) bool { return item.OperationId != operationId })
		toolOrder, tools := conversationFilterTools(state.LiveToolsOrder, state.LiveTools, func(item LiveTool) bool { return item.OperationId != operationId })
		state.LiveText = text
		state.LiveTextOrder = textOrder
		state.LiveTools = tools
		state.LiveToolsOrder = toolOrder
		state.StreamNeedsResync = false
		return state
	}
	if data == nil || data.Message == nil || (event.Type != "message.created" && event.Type != "message.updated") {
		return state
	}
	message := *data.Message
	knownMax := 0
	for _, candidate := range state.Records {
		if candidate.Seq > knownMax {
			knownMax = candidate.Seq
		}
	}
	records := state.Records
	if event.Type == "message.updated" || message.Seq > knownMax {
		records = mergeConversationRecords(state.Records, []ConversationMessage{message})
	}
	text := map[string]LiveText{}
	for key, item := range state.LiveText {
		text[key] = item
	}
	order := append([]string{}, state.LiveTextOrder...)
	if message.Role == "assistant" && message.OperationId != nil {
		order, text = conversationFilterText(order, text, func(item LiveText) bool { return item.OperationId != *message.OperationId })
	}
	tools := map[string]LiveTool{}
	for key, item := range state.LiveTools {
		tools[key] = item
	}
	toolOrder := append([]string{}, state.LiveToolsOrder...)
	if message.Role == "tool" {
		if callID, ok := message.Data["toolCallId"].(string); ok {
			delete(tools, callID)
			toolOrder, tools = conversationFilterTools(toolOrder, tools, func(item LiveTool) bool { return item.ToolCallId != callID })
		}
	}
	state.Records = records
	state.LiveText = text
	state.LiveTextOrder = order
	state.LiveTools = tools
	state.LiveToolsOrder = toolOrder
	state.StreamNeedsResync = false
	return state
}

func conversationDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func conversationSorted(state ConversationProjectionState) []ConversationMessage {
	all := make([]ConversationMessage, 0, len(state.Records))
	for _, message := range state.Records {
		all = append(all, message)
	}
	for i := 1; i < len(all); i++ {
		item := all[i]
		j := i
		for j > 0 && all[j-1].Seq > item.Seq {
			all[j] = all[j-1]
			j--
		}
		all[j] = item
	}
	return all
}

// ConversationHistoryRequestOf is the next page the projection still needs.
func ConversationHistoryRequestOf(state ConversationProjectionState) *ConversationHistoryRequest {
	if state.HistoryExhausted || state.MessageCount <= len(state.Records) {
		return nil
	}
	cached := conversationSorted(state)
	if !state.OlderExhausted && len(cached) > 0 && cached[0].Seq > 1 {
		return &ConversationHistoryRequest{Direction: "before", Cursor: cached[0].Seq}
	}
	below := cached
	if state.WindowStartSeq != nil {
		below = []ConversationMessage{}
		for _, message := range cached {
			if message.Seq < *state.WindowStartSeq {
				below = append(below, message)
			}
		}
	}
	base := 0
	if len(cached) > 0 {
		base = cached[0].Seq
	}
	if len(below) > 0 {
		base = below[len(below)-1].Seq
	}
	cursor := base
	if state.ForwardCursor != nil && *state.ForwardCursor > cursor {
		cursor = *state.ForwardCursor
	}
	return &ConversationHistoryRequest{Direction: "after", Cursor: cursor}
}

// ObserveConversationHistory merges one history page.
func ObserveConversationHistory(state ConversationProjectionState, request ConversationHistoryRequest, messages []ConversationMessage) ConversationProjectionState {
	state.Records = mergeConversationRecords(state.Records, messages)
	if request.Direction == "after" {
		if len(messages) == 0 {
			state.HistoryExhausted = true
			return state
		}
		seq := messages[len(messages)-1].Seq
		state.ForwardCursor = &seq
		return state
	}
	if len(messages) == 0 {
		state.OlderExhausted = true
	}
	return state
}

// ConversationProjectionSnapshot renders the current view.
func ConversationProjectionSnapshot(state ConversationProjectionState, busy bool) ConversationSnapshot {
	all := conversationSorted(state)
	queued := []ConversationMessage{}
	durableOps := map[string]bool{}
	durableTools := map[string]bool{}
	durableNarration := map[string]bool{}
	var latest *ConversationMessage
	for _, message := range all {
		if message.Role == "user" && message.State == "queued" {
			queued = append(queued, message)
		}
		if message.Role == "assistant" && message.OperationId != nil {
			durableOps[*message.OperationId] = true
			copy := message
			latest = &copy
		}
		if message.Role == "tool" {
			if callID, ok := message.Data["toolCallId"].(string); ok {
				durableTools[callID] = true
			}
		}
		if message.Role == "activity" {
			if _, ok := message.Data["ordinal"].(float64); ok || conversationOrdinalPresent(message.Data) {
				op := ""
				if message.OperationId != nil {
					op = *message.OperationId
				}
				durableNarration[op+":"+conversationOrdinalText(message.Data["ordinal"])] = true
			}
		}
	}
	visible := []ConversationMessage{}
	for _, message := range all {
		if message.Role == "user" && message.State == "queued" {
			continue
		}
		visible = append(visible, message)
	}
	streaming := []LiveText{}
	for _, key := range state.LiveTextOrder {
		item, ok := state.LiveText[key]
		if !ok || durableOps[item.OperationId] || durableNarration[item.OperationId+":"+conversationItoa(item.Ordinal)] {
			continue
		}
		streaming = append(streaming, item)
	}
	live := []LiveTool{}
	for _, key := range state.LiveToolsOrder {
		item, ok := state.LiveTools[key]
		if !ok || durableTools[item.ToolCallId] {
			continue
		}
		live = append(live, item)
	}
	suggestion := ""
	if latest != nil {
		if text, ok := latest.Data["suggestedPrompt"].(string); ok {
			suggestion = strings.TrimSpace(text)
			if utf16Len(suggestion) > 500 {
				suggestion = utf16Slice(suggestion, 500)
			}
		}
	}
	if busy || len(queued) > 0 {
		suggestion = ""
	}
	return ConversationSnapshot{
		Messages: orderConversationMessages(visible), QueuedMessages: queued, Streaming: streaming, LiveTools: live,
		PromptSuggestion: suggestion, StreamNeedsResync: state.StreamNeedsResync, HistoryRequest: ConversationHistoryRequestOf(state),
	}
}

func conversationOrdinalPresent(data map[string]any) bool {
	switch data["ordinal"].(type) {
	case float64, int, int64:
		return true
	default:
		return false
	}
}

func conversationOrdinalText(value any) string {
	switch typed := value.(type) {
	case float64:
		return trimFloat(typed)
	case int:
		return conversationItoa(typed)
	case int64:
		return conversationItoa(int(typed))
	default:
		return ""
	}
}

func trimFloat(value float64) string {
	return strings.TrimRight(strings.TrimRight(formatFloat(value), "0"), ".")
}

func formatFloat(value float64) string {
	return strings.TrimSpace(strings.ReplaceAll(CanonicalJSON(value), " ", ""))
}

func conversationItoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

// MessageAttachment is one file hanging off a message.
type MessageAttachment struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Size     int    `json:"size"`
	Text     string `json:"text"`
	Data     string `json:"data,omitempty"`
	ImageUrl string `json:"imageUrl,omitempty"`
}

// MessageAttachments lists image and text attachments with stable URLs.
func MessageAttachments(message ConversationMessage) []MessageAttachment {
	if message.Data == nil {
		return []MessageAttachment{}
	}
	value, ok := message.Data["attachments"].([]any)
	if !ok {
		return []MessageAttachment{}
	}
	out := []MessageAttachment{}
	for index, item := range value {
		attachment, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, nameOK := attachment["name"].(string)
		text, textOK := attachment["text"].(string)
		if !nameOK || !textOK {
			continue
		}
		kind := "text/plain"
		if typed, ok := attachment["type"].(string); ok {
			kind = typed
		}
		size := utf16Len(text)
		if number, ok := attachment["size"].(float64); ok {
			size = int(number)
		} else if number, ok := attachment["size"].(int); ok {
			size = number
		}
		row := MessageAttachment{Name: name, Type: kind, Size: size, Text: text}
		if data, ok := attachment["data"].(string); ok {
			row.Data = data
		}
		if kind == "image/png" || kind == "image/jpeg" || kind == "image/webp" || kind == "image/gif" {
			row.ImageUrl = "/api/messages/" + conversationEncodeURIComponent(message.Id) + "/attachments/" + conversationItoa(index)
		}
		out = append(out, row)
	}
	return out
}

func conversationEncodeURIComponent(value string) string {
	encoded := url.QueryEscape(value)
	replacer := strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*")
	return replacer.Replace(encoded)
}
