package graph

import (
	"encoding/json"
	"sort"
	"strings"
)

const evidenceRawLineLimit = 200

type StreamToolCallEvidence struct {
	Index          int    `json:"index"`
	Name           string `json:"name"`
	AssembledChars int    `json:"assembledChars"`
	FragmentChars  int    `json:"fragmentChars"`
	Valid          bool   `json:"valid"`
}

type StreamEvidence struct {
	Class           string                   `json:"class"`
	Why             string                   `json:"why"`
	FinishReason    string                   `json:"finishReason"`
	Terminated      bool                     `json:"terminated"`
	ToolCalls       []StreamToolCallEvidence `json:"toolCalls"`
	Received        map[int]string           `json:"received"`
	Assembled       map[int]string           `json:"assembled"`
	RawLines        []string                 `json:"rawLines,omitempty"`
	RawLinesDropped int                      `json:"rawLinesDropped"`
}

func (stream *controlledStream) recordRawLine(line string) {
	if strings.TrimSpace(line) == "" {
		return
	}
	stream.rawLines = append(stream.rawLines, line)
	if len(stream.rawLines) > evidenceRawLineLimit {
		stream.rawLinesDropped += len(stream.rawLines) - evidenceRawLineLimit
		stream.rawLines = stream.rawLines[len(stream.rawLines)-evidenceRawLineLimit:]
	}
}

func (stream *controlledStream) streamEvidence(failure error) StreamEvidence {
	evidence := StreamEvidence{
		FinishReason:    stream.finishReason,
		Terminated:      stream.terminated,
		ToolCalls:       []StreamToolCallEvidence{},
		Received:        map[int]string{},
		Assembled:       map[int]string{},
		RawLines:        append([]string{}, stream.rawLines...),
		RawLinesDropped: stream.rawLinesDropped,
	}
	indexes := make([]int, 0, len(stream.toolCalls))
	for index := range stream.toolCalls {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		call := stream.toolCalls[index]
		received := strings.Join(call.fragments, "")
		assembled := call.arguments.String()
		_, valid := decodeJSONValue(strings.TrimSpace(received))
		evidence.ToolCalls = append(evidence.ToolCalls, StreamToolCallEvidence{
			Index: index, Name: call.name, AssembledChars: len(assembled), FragmentChars: len(received), Valid: valid,
		})
		if received != "" {
			evidence.Received[index] = received
		}
		if assembled != "" {
			evidence.Assembled[index] = assembled
		}
		if received != assembled {
			evidence.Class = "assembler_bug"
			evidence.Why = "the assembled arguments differ from the fragments the provider sent"
		}
	}
	if evidence.Class == "" {
		switch {
		case stream.finishReason == "length":
			evidence.Class = "model_output_invalid"
			evidence.Why = "the reply hit the output limit before its tool arguments were complete"
		case failure == nil:
			evidence.Class = "complete"
			evidence.Why = "the stream completed with valid tool arguments"
		case !stream.finishReasonReported():
			evidence.Class = "transport_cut"
			evidence.Why = "the stream ended before the provider reported a finish reason"
		case isArgumentFailure(failure):
			evidence.Class = "model_output_invalid"
			evidence.Why = "the provider sent a complete reply whose tool arguments do not decode"
		default:
			evidence.Class = "transport_cut"
			evidence.Why = "the provider failed after it reported a finish reason"
		}
	}
	return evidence
}

func isArgumentFailure(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "arguments of the") || strings.Contains(message, "arguments were complete")
}

func (evidence StreamEvidence) Fields() map[string]any {
	return map[string]any{
		"class":           evidence.Class,
		"why":             evidence.Why,
		"finishReason":    evidence.FinishReason,
		"terminated":      evidence.Terminated,
		"toolCalls":       evidence.ToolCalls,
		"received":        evidence.Received,
		"assembled":       evidence.Assembled,
		"rawLines":        evidence.RawLines,
		"rawLinesDropped": evidence.RawLinesDropped,
	}
}

func (evidence StreamEvidence) JSON() string {
	payload, err := json.Marshal(evidence.Fields())
	if err != nil {
		return evidence.Class
	}
	return string(payload)
}
