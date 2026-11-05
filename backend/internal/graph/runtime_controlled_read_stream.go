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

// readEvents reads the provider event stream.
//
// A stream that ends without its terminator was cut: the provider closed the
// connection, or the transport failed, before the answer was complete. Such a
// stream is a failed send, not a successful turn whose missing text happens
// to parse as an empty answer. Reporting it as a success is what let a
// half-written tool call reach the tools as a call with no arguments.
//
// It returns the failure the same send has to be sent again after, and nil when
// the attempt settled the stream - with an answer, or with the failure the turn
// ends on. remaining is the retry budget this attempt may still spend.
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
	// readFailure is the error that ended the read, when there was one: it is
	// the original failure a cut stream is explained with.
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
				failure = errors.New("The provider stopped sending before the answer was complete")
				bodyOpen = true
			} else if !errors.Is(err, io.EOF) {
				failure = err
				bodyOpen = true
			}
			break
		}
	}
	// A provider that stopped answering is still holding the connection open,
	// and everything that reads the rest of the body would wait for it: the
	// estimate below reads the body to its end, and closing the body drains
	// what is left of it. Both would hold the turn, the credential slot and
	// the node for exactly as long as the provider keeps talking, so the
	// request is cancelled first and the body is not read again.
	if bodyOpen {
		stream.cancelRequest()
	}
	if failure == nil && !terminated && !stream.finishReasonReported() {
		failure = cutStreamFailure()
	}
	if failure == nil {
		failure = stream.brokenToolCall()
	}
	// The attempt is sent again only when nothing of it was answered and the
	// failure is one a fresh connection can change. A partial answer is
	// evidence somebody has to read, and a stopped attempt is the caller's own
	// decision: neither may be replayed behind their back.
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
		// Nothing was answered and the very same request is about to go again:
		// the dead attempt settles as producing no usage, or the gate would
		// refuse the next send over an unknown call nobody can reconcile.
		usage = &controlledZeroUsage
	}
	// The transcript keeps the usage the provider billed. The kernel's own
	// context estimate anchors on the last measured message; without this
	// every session looked like it had never been billed, so its threshold
	// compaction measured a context that never grew and never compacted.
	stream.message.Usage = assistantUsageOf(usage)
	stream.settle(usage)
	if replay {
		return failure
	}
	if failure != nil {
		// A timeout or a stream the provider cut is a boundary failure when no
		// answer byte arrived; failTransport decides that and leaves a partial
		// answer's failure standing as it is.
		reported := failure
		retries := TRANSPORT_RETRIES - remaining
		if retries > 0 && readFailure != nil && !errors.Is(reported, readFailure) {
			// Name the original failure next to the cut it caused: the retry
			// count alone does not say whether the connection broke or the
			// provider went quiet.
			reported = fmt.Errorf("%s: %w", reported.Error(), readFailure)
		}
		// The retry budget this send spent is named in the failure, so the user
		// reads how many times the daemon already tried instead of being asked
		// to send the message again.
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
