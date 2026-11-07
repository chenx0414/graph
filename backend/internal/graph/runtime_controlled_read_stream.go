package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var providerStreamStalled = errors.New("The provider stopped sending before the answer was complete")

func (stream *controlledStream) readEvents(response *http.Response, remaining int) error {
	defer response.Body.Close()
	stream.message = &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: string(stream.api), Provider: providerOf(stream.model), Model: modelIDOf(stream.model),
		StopReason: "pending", Timestamp: NowMillis(),
	}
	stream.events = append(stream.events, map[string]any{"type": "start", "partial": stream.partial()})
	lines := newProviderLineReader(response.Body)
	defer lines.close()
	evidence := controlledUsageEvidence{}
	terminated := false
	var failure error
	var readFailure error
	bodyOpen := false
	lastEvent := time.Now()
	idle := providerStreamIdleTimeout()
	for {
		line, err := lines.read(idle - time.Since(lastEvent))
		if line != "" {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "data:") {
				payload := strings.TrimSpace(trimmed[5:])
				if payload == "[DONE]" {
					terminated = true
					break
				}
				if payload != "" {
					var event map[string]any
					if json.Unmarshal([]byte(payload), &event) == nil {
						stream.handleEvent(event)
						evidence.feed(trimmed, stream.api)
						lastEvent = time.Now()
					}
				}
			}
		}
		if evidence.terminal {
			terminated = true
			break
		}
		if err != nil {
			readFailure = err
			if errors.Is(err, os.ErrDeadlineExceeded) {
				failure = providerStreamStalled
				bodyOpen = true
			} else if !errors.Is(err, io.EOF) {
				failure = err
				bodyOpen = true
			}
			break
		}
	}
	if bodyOpen {
		stream.cancelRequest()
	}
	if failure == nil && !terminated && !stream.finishReasonReported() {
		failure = cutStreamFailure()
	}
	if failure == nil {
		failure = stream.brokenToolCall()
	}
	replay := failure != nil && remaining > 0 && stream.answeredNothing() && controlledReplayableFailure(failure)
	usage := evidence.result(stream.api)
	if usage == nil && !bodyOpen && !replay {
		if stream.usageOptions.EstimateMissing {
			estimated := stream.estimateUsage(response)
			if estimated != nil {
				usage = estimated
			}
		}
	}
	if usage == nil {
		usage = &TokenUsage{UsageSource: stringPointer(string(UsageUnknown))}
	}
	if replay {
		usage = &controlledZeroUsage
	}
	stream.message.Usage = assistantUsageOf(usage)
	stream.settle(usage)
	if replay {
		return failure
	}
	if failure != nil {
		reported := failure
		retries := TRANSPORT_RETRIES - remaining
		if retries > 0 && readFailure != nil && !errors.Is(reported, readFailure) {
			reported = fmt.Errorf("%s: %w", reported.Error(), readFailure)
		}
		stream.failTransport(TransportRetryExhausted(reported, retries))
		return nil
	}
	reason := stream.finishReason
	if reason == "" {
		reason = "stop"
	}
	stream.message.StopReason = reason
	stream.events = append(stream.events, map[string]any{
		"type": "done", "reason": reason, "message": asMap(stream.message),
	})
	return nil
}
