package graph

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const TRANSPORT_RETRIES = 2

func transportRetryBackoffMs(retry int) int {
	if retry < 1 {
		retry = 1
	}
	return 500 << (retry - 1)
}

var transportRetryMarker = regexp.MustCompile(`the transport retried (\d+) times`)

func TransportRetryExhausted(failure error, retries int) error {
	if failure == nil || retries < 1 {
		return failure
	}
	return fmt.Errorf("%w (the transport retried %d times)", failure, retries)
}

func TransportRetries(reason string) (int, bool) {
	match := transportRetryMarker.FindStringSubmatch(reason)
	if match == nil {
		return 0, false
	}
	count, err := strconv.Atoi(match[1])
	if err != nil || count < 1 {
		return 0, false
	}
	return count, true
}

func cutStreamFailure() error {
	return errors.New("The provider closed the stream before the answer was complete")
}

func (stream *controlledStream) observeReconnect(retry, delay int, failure error) {
	observe := stream.usageOptions.OnTransport
	if observe == nil {
		return
	}
	next := retry + 1
	observation := ProviderTransportObservation{
		CallID:     stream.invocation,
		At:         NowMillis(),
		Phase:      "reconnect",
		Attempt:    &next,
		DelayMs:    &delay,
		ErrorCodes: controlledTransportErrorCodes(failure),
	}
	defer func() { _ = recover() }()
	observe(observation)
}

func (stream *controlledStream) answeredNothing() bool {
	if stream.finishReason != "" {
		return false
	}
	if stream.message == nil {
		return true
	}
	for _, block := range stream.message.Content {
		if block.Type == "toolCall" || strings.TrimSpace(block.Text) != "" || strings.TrimSpace(block.Thinking) != "" {
			return false
		}
	}
	return true
}

func (stream *controlledStream) discardAttempt() {
	stream.message = nil
	stream.events = nil
	stream.index = 0
	stream.toolCalls = map[int]*controlledToolCall{}
	stream.toolCallBlocks = map[int]int{}
	stream.settled = false
	stream.invocation = ""
	stream.finishReason = ""
	stream.transport = false
}
