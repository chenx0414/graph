package graph

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"bufio"
)

// providerStreamIdleTimeout is how long a provider stream may say nothing.
//
// The upstream kernel ends such a stream after five minutes, and so does the
// daemon. The environment variable narrows the bound for a provider that is
// known to be slow, and lets the test that proves the bound fires run in
// seconds instead of minutes.
func providerStreamIdleTimeout() time.Duration {
	const fallback = 5 * time.Minute
	raw := strings.TrimSpace(os.Getenv("GRAPH_PROVIDER_STREAM_IDLE_TIMEOUT"))
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
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
