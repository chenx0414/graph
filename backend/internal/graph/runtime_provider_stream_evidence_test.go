package graph

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func evidenceStream(finish string, calls map[int]string, received map[int]string) *controlledStream {
	stream := &controlledStream{
		message: &AssistantMessage{Role: "assistant"}, finished: true,
		toolCalls: map[int]*controlledToolCall{}, toolCallBlocks: map[int]int{}, finishReason: finish,
	}
	for index, args := range calls {
		stream.toolCalls[index] = &controlledToolCall{id: "call-" + string(rune('a'+index)), name: "edit"}
		stream.toolCalls[index].arguments.WriteString(args)
	}
	for index, text := range received {
		if call, ok := stream.toolCalls[index]; ok {
			call.fragments = []string{text}
		}
	}
	return stream
}

func TestBrokenArgumentsWithATerminalFinishReasonAreTheModelsOwnOutput(t *testing.T) {
	stream := evidenceStream("toolUse", map[int]string{0: `{"edits":[{"oldText":"a"`}, map[int]string{0: `{"edits":[{"oldText":"a"`})
	evidence := stream.streamEvidence(stream.brokenToolCall())
	if evidence.Class != "model_output_invalid" {
		t.Fatalf("a complete stream with unusable arguments is the model's own output, got %q (%s)", evidence.Class, evidence.Why)
	}
}

func TestBrokenArgumentsWithALengthStopAreTheOutputLimit(t *testing.T) {
	stream := evidenceStream("length", map[int]string{0: `{"edits":[{"oldText":"a"`}, map[int]string{0: `{"edits":[{"oldText":"a"`})
	evidence := stream.streamEvidence(stream.brokenToolCall())
	if evidence.Class != "model_output_invalid" {
		t.Fatalf("a token-limited reply is the model's own output, got %q", evidence.Class)
	}
	if !strings.Contains(evidence.Why, "output limit") {
		t.Fatalf("the evidence must say the reply hit the output limit: %q", evidence.Why)
	}
}

func TestArgumentsThatLostTheirFragmentsAreAnAssemblerDefect(t *testing.T) {
	stream := evidenceStream("toolUse", map[int]string{0: `{"edits":[]`}, map[int]string{0: `{"edits":[],"more":1}`})
	evidence := stream.streamEvidence(stream.brokenToolCall())
	if evidence.Class != "assembler_bug" {
		t.Fatalf("arguments that differ from the streamed fragments are our defect, got %q (%s)", evidence.Class, evidence.Why)
	}
}

func TestAStreamThatEndedEarlyIsATransportCut(t *testing.T) {
	stream := evidenceStream("", map[int]string{0: `{"edits":[`}, map[int]string{0: `{"edits":[`})
	evidence := stream.streamEvidence(providerStreamStalled)
	if evidence.Class != "transport_cut" {
		t.Fatalf("a stream with no finish reason was cut in transport, got %q", evidence.Class)
	}
}

func TestTheEvidenceNamesTheFinishReasonAndEveryToolCallIndex(t *testing.T) {
	stream := evidenceStream("toolUse", map[int]string{0: `{"a":`, 2: `{"b":1}`}, map[int]string{0: `{"a":`, 2: `{"b":1}`})
	evidence := stream.streamEvidence(stream.brokenToolCall())
	if evidence.FinishReason != "toolUse" {
		t.Fatalf("the evidence must carry the finish reason, got %q", evidence.FinishReason)
	}
	if len(evidence.ToolCalls) != 2 {
		t.Fatalf("every tool call index must be named, got %+v", evidence.ToolCalls)
	}
	if evidence.ToolCalls[0].Index != 0 || evidence.ToolCalls[0].Valid || !evidence.ToolCalls[1].Valid {
		t.Fatalf("each call must say whether its own arguments decoded: %+v", evidence.ToolCalls)
	}
	if evidence.Received[0] != `{"a":` {
		t.Fatalf("the evidence must keep the fragments the provider sent: %+v", evidence.Received)
	}
}

func TestTheEvidenceKeepsTheLastRawLinesAndSaysHowManyItDropped(t *testing.T) {
	stream := evidenceStream("stop", map[int]string{}, nil)
	for index := 0; index < evidenceRawLineLimit+5; index++ {
		stream.recordRawLine("data: line-" + itoa(index))
	}
	evidence := stream.streamEvidence(nil)
	if len(evidence.RawLines) != evidenceRawLineLimit {
		t.Fatalf("the evidence must keep a bounded tail, got %d lines", len(evidence.RawLines))
	}
	if evidence.RawLinesDropped != 5 {
		t.Fatalf("the evidence must say how many lines it dropped, got %d", evidence.RawLinesDropped)
	}
	if evidence.RawLines[len(evidence.RawLines)-1] != "data: line-"+itoa(evidenceRawLineLimit+4) {
		t.Fatalf("the tail must end at the newest line, got %q", evidence.RawLines[len(evidence.RawLines)-1])
	}
}

// The evidence is only useful if the stream actually records it on the path
// that reports the failure. The provider here returns a tool call whose
// arguments stop halfway and then claims the call is complete; the reader must
// keep the raw frames, the finish reason and the fragments, and classify it as
// the model's own invalid output rather than a transport cut.
func TestABrokenToolCallLeavesEvidenceOnTheStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		frame := func(payload string) { _, _ = w.Write([]byte("data: " + payload + "\n\n")) }
		frame(`{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"edit","arguments":"{\"edits\":[{\"oldText\":\"a\""}}]}}]}`)
		frame(`{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	entry := ModelEntry{Id: "m", Provider: "p", Api: "openai-completions", BaseUrl: server.URL + "/v1", ContextWindow: 8000, MaxTokens: 256}
	gate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any { return send() },
		Settle:   func(string, *TokenUsage) {},
	}
	stream := ControlledOpenAIStream(gate, entry, func(ModelEntry) string { return "key" }, func(ModelEntry) *piAdapterSlot { return nil }, "openai-completions", PiAdapterStreamOptions{})
	opened, err := stream(map[string]any{"id": "m", "api": "openai-completions", "provider": "p", "baseUrl": entry.BaseUrl},
		map[string]any{"messages": []any{map[string]any{"role": "user", "content": "edit it"}}}, nil)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	var evidence map[string]any
	for {
		event, ok := opened.Next()
		if !ok {
			break
		}
		if event["type"] != "stream_evidence" {
			continue
		}
		evidence, _ = event["evidence"].(map[string]any)
	}
	if evidence == nil {
		t.Fatalf("the failure left no stream evidence in the event sequence")
	}
	if evidence["class"] != "model_output_invalid" {
		t.Fatalf("a terminal finish with broken arguments is the model's output, got %v", evidence)
	}
	if evidence["terminated"] != true {
		t.Fatalf("the evidence must say the provider reached [DONE], got %v", evidence)
	}
	if lines, _ := evidence["rawLines"].([]string); len(lines) == 0 {
		t.Fatalf("the evidence must keep the raw SSE frames, got %v", evidence)
	}
	if calls, _ := evidence["toolCalls"].([]StreamToolCallEvidence); len(calls) != 1 || calls[0].Valid {
		t.Fatalf("the evidence must name the broken call, got %v", evidence["toolCalls"])
	}
}
