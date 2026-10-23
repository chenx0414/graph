package graph

import (
	"encoding/json"
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
	Type              string         `json:"type"`
	Text              string         `json:"text,omitempty"`
	TextSignature     *string        `json:"textSignature,omitempty"`
	Thinking          string         `json:"thinking,omitempty"`
	ThinkingSignature *string        `json:"thinkingSignature,omitempty"`
	Redacted          *bool          `json:"redacted,omitempty"`
	Id                string         `json:"id,omitempty"`
	Name              string         `json:"name,omitempty"`
	Arguments         map[string]any `json:"arguments,omitempty"`
	ThoughtSignature  *string        `json:"thoughtSignature,omitempty"`
	Namespace         *string        `json:"namespace,omitempty"`
}

// AssistantToolCall is one tool call an assistant message carries.
type AssistantToolCall struct {
	Type             string         `json:"type"`
	Id               string         `json:"id"`
	Name             string         `json:"name"`
	Arguments        map[string]any `json:"arguments"`
	ThoughtSignature *string        `json:"thoughtSignature,omitempty"`
	Namespace        *string        `json:"namespace,omitempty"`
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
