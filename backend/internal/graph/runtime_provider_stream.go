package graph

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Reading the provider's answer.
//
// The daemon builds the provider request itself, so it reads the answer
// itself as well. Three things have to hold for the turn to mean what it
// says:
//
//   - a stream that ends without its terminator was cut, and a cut stream is
//     a failed send rather than a successful turn with a short answer;
//   - a tool call whose arguments never became JSON never reaches a tool;
//   - a provider that stops answering fails the send instead of holding the
//     turn, the credential slot and the node for ever.
//
// The upstream kernel holds the same line: it ends a stream that keeps
// sending keepalive comments but no event after five minutes, and it
// distinguishes a compaction that compacted nothing from one that did.

// providerStreamIdleTimeout is how long a provider stream may say nothing.
const providerStreamIdleTimeout = 5 * time.Minute

// readEvents reads the provider event stream.
//
// A stream that ends without its terminator was cut: the provider closed the
// connection, or the transport failed, before the answer was complete. Such a
// stream is a failed send, not a successful turn whose missing text happens
// to parse as an empty answer. Reporting it as a success is what let a
// half-written tool call reach the tools as a call with no arguments.
func (stream *controlledStream) readEvents(response *http.Response) {
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
	lastEvent := time.Now()
	for {
		line, err := lines.read(providerStreamIdleTimeout - time.Since(lastEvent))
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
			if errors.Is(err, os.ErrDeadlineExceeded) {
				failure = errors.New("The provider stopped sending before the answer was complete")
			} else if !errors.Is(err, io.EOF) {
				failure = err
			}
			break
		}
	}
	usage := evidence.result(stream.api)
	if usage == nil {
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
	stream.settle(usage)
	if failure == nil && !terminated && !stream.finishReasonReported() {
		failure = errors.New("The provider closed the stream before the answer was complete")
	}
	if failure == nil {
		failure = stream.brokenToolCall()
	}
	if failure != nil {
		stream.fail(failure)
		return
	}
	reason := stream.finishReason
	if reason == "" {
		reason = "stop"
	}
	stream.message.StopReason = reason
	stream.events = append(stream.events, map[string]any{
		"type": "done", "reason": reason, "message": asMap(stream.message),
	})
}

// finishReasonReported reports whether the provider said how the turn ended.
//
// The OpenAI protocol ends a chunk with a finish reason, and a provider that
// never sends the `[DONE]` marker still says so there. Anthropic says it in
// `message_delta` and closes the message with `message_stop`.
func (stream *controlledStream) finishReasonReported() bool {
	return stream.finishReason != ""
}

// brokenToolCall reports the tool call whose arguments never became JSON.
//
// The arguments of a tool call arrive as a stream of text. A call whose text
// is cut short used to be repaired into an empty object, so the tool ran with
// no arguments at all and the turn was reported as a success.
func (stream *controlledStream) brokenToolCall() error {
	for _, call := range stream.toolCalls {
		text := strings.TrimSpace(call.arguments.String())
		if text == "" {
			continue
		}
		if _, ok := decodeJSONValue(text); !ok {
			return fmt.Errorf("The provider cut the arguments of the %s tool call", call.name)
		}
	}
	return nil
}

// providerLineReader reads one line of a provider stream at a time.
//
// The read happens in the background so that the caller can bound it: a
// provider that stops answering has to fail the send rather than hold the
// turn. The reader is closed with the body, which ends the background read.
type providerLineReader struct {
	body  io.ReadCloser
	lines chan providerLine
	// done ends the background read when the stream is over. Without it the
	// reader waits for a line nobody will take.
	done chan struct{}
}

// providerLine is one line of a provider stream.
type providerLine struct {
	text string
	err  error
}

// newProviderLineReader starts reading the lines of a provider stream.
func newProviderLineReader(body io.ReadCloser) *providerLineReader {
	reader := &providerLineReader{
		body:  body,
		lines: make(chan providerLine, 1),
		done:  make(chan struct{}),
	}
	go func() {
		buffered := bufio.NewReader(body)
		for {
			text, err := buffered.ReadString('\n')
			select {
			case reader.lines <- providerLine{text: text, err: err}:
			case <-reader.done:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return reader
}

// read returns the next line, or an error when the provider stayed quiet for
// longer than the timeout allows.
func (reader *providerLineReader) read(timeout time.Duration) (string, error) {
	if timeout <= 0 {
		return "", os.ErrDeadlineExceeded
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case line := <-reader.lines:
		return line.text, line.err
	case <-timer.C:
		return "", os.ErrDeadlineExceeded
	}
}

// close ends the background read.
func (reader *providerLineReader) close() {
	close(reader.done)
}
