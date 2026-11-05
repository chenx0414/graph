package graph

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// TRANSPORT_RETRIES is how many times one provider send is repeated after the
// connection died before any answer byte arrived.
//
// The send is repeated, not the turn. A turn retry would run the tools that
// already ran (a file written twice, a command that appended twice), while the
// send whose answer nobody read can be sent again on a fresh connection with
// nothing lost: the transcript, the durable submission and the user's message
// stay exactly what they were.
const TRANSPORT_RETRIES = 2

// transportRetryBackoffMs is how long the transport waits before sending one
// request again.
//
// 500ms, then 1000ms: long enough that a corrupted connection is not dialled
// again in the same burst, short enough that a person waiting for a reply does
// not have to notice the wait.
func transportRetryBackoffMs(retry int) int {
	if retry < 1 {
		retry = 1
	}
	return 500 << (retry - 1)
}

// transportRetryMarker is how a failure names the retries the transport spent.
//
// The failure travels to the user as text, so the count travels with it: the
// line that tells the user what happened is the line that says how many times
// the daemon already tried on their behalf.
var transportRetryMarker = regexp.MustCompile(`the transport retried (\d+) times`)

// TransportRetryExhausted marks a failure the transport gave up on after
// sending the same request again.
//
// The original failure stays the wrapped error, message and identity included:
// only the count of automatic retries is added, so nothing that failed here was
// silently believed to have succeeded.
func TransportRetryExhausted(failure error, retries int) error {
	if failure == nil || retries < 1 {
		return failure
	}
	return fmt.Errorf("%w (the transport retried %d times)", failure, retries)
}

// TransportRetries reads the retry count one failure names, if it names one.
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

// cutStreamFailure is why a provider stream that ended without its terminator
// failed.
//
// Only the sentence is named here: the read failure that ended the stream is
// added where the retry budget is spent, because until then this failure must
// keep the meaning it always had - the provider closed a stream mid-answer, and
// the turn may be sent again.
func cutStreamFailure() error {
	return errors.New("The provider closed the stream before the answer was complete")
}

// observeReconnect reports the wait before one send is tried again.
//
// The observation names the attempt that failed (its call id is the one the
// ledger already knows) and how long the transport waits, so a timeline reader
// can tell a retry apart from a first attempt.
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

// answeredNothing reports whether one attempt produced no answer byte: no text,
// no reasoning, no tool call and no finish reason.
//
// Only such an attempt may be sent again: nothing of it reached the transcript,
// so no tool can have run from it and the same request is still the request the
// model has to answer.
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

// discardAttempt drops everything one attempt produced, so the replay starts
// from the same transcript and no event of the dead attempt reaches the caller.
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
