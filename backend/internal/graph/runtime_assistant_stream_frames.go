package graph

import (
	"encoding/json"
)

type AssistantUsageCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

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

type AssistantContentBlock struct {
	Type              string  `json:"type"`
	Text              string  `json:"text,omitempty"`
	TextSignature     *string `json:"textSignature,omitempty"`
	Thinking          string  `json:"thinking,omitempty"`
	ThinkingSignature *string `json:"thinkingSignature,omitempty"`
	Redacted          *bool   `json:"redacted,omitempty"`
	Id                string  `json:"id,omitempty"`
	Name              string  `json:"name,omitempty"`
	Arguments        any     `json:"arguments,omitempty"`
	ThoughtSignature *string `json:"thoughtSignature,omitempty"`
	Namespace        *string `json:"namespace,omitempty"`
}

type AssistantToolCall struct {
	Type             string  `json:"type"`
	Id               string  `json:"id"`
	Name             string  `json:"name"`
	Arguments        any     `json:"arguments"`
	ThoughtSignature *string `json:"thoughtSignature,omitempty"`
	Namespace        *string `json:"namespace,omitempty"`
}

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
	DurationMs            *int64                  `json:"durationMs,omitempty"`
}

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

type assistantFrameBlock struct {
	kind              string
	coveredChars      int
	deltaChars        int
	caughtUp          bool
	catchupJson       string
	snapshotArguments string
}

type assistantMessageFrameEncoder struct {
	started  bool
	terminal bool
	blocks   map[int]*assistantFrameBlock
}

func newAssistantMessageFrameEncoder() *assistantMessageFrameEncoder {
	return &assistantMessageFrameEncoder{blocks: map[int]*assistantFrameBlock{}}
}

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

func assistantToolCallArguments(arguments any) any {
	if arguments == nil {
		return map[string]any{}
	}
	return cloneAssistantArguments(arguments)
}
