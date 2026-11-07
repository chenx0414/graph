package graph

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"bufio"
)

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

func (stream *controlledStream) finishReasonReported() bool {
	return stream.finishReason != ""
}

func (stream *controlledStream) brokenToolCall() error {
	for _, call := range stream.toolCalls {
		text := strings.TrimSpace(call.arguments.String())
		if text == "" {
			continue
		}
		if _, ok := decodeJSONValue(text); !ok {
			if stream.finishReason == "length" {
				return fmt.Errorf("The reply hit the output token limit before the arguments of the %s tool call were complete", call.name)
			}
			return fmt.Errorf("The provider cut the arguments of the %s tool call", call.name)
		}
	}
	return nil
}

type providerLineReader struct {
	body  io.ReadCloser
	lines chan providerLine
	done chan struct{}
}

type providerLine struct {
	text string
	err  error
}

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

func (reader *providerLineReader) close() {
	close(reader.done)
}
