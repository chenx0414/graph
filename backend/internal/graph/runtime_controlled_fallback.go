package graph

// A send that falls back to another model when the provider boundary breaks.
//
// The fallback is an availability decision, not a second opinion: it happens
// only when the primary produced no answer because the transport or the
// protocol failed - a connection error or EOF, a timeout, a non-2xx status, or
// a stream that ended before its answer. A model that answered badly is never
// re-asked somewhere else: that answer is the turn's answer, and re-deciding it
// would hide the fact that the review was made by the model the graph named.
//
// The switch happens inside one send, so the turn that was already running
// continues: the caller sees one answer, and the four facts of the fallback
// (primary model, the failure verbatim, fallback model, whether the two models
// are the same) are recorded by the caller that owns the configuration.

// ModelFallbackRecord is what one transport fallback has to record.
type ModelFallbackRecord struct {
	// PrimaryModel is the model id the send started on.
	PrimaryModel string
	// Error is the provider failure verbatim, as the client reported it.
	Error string
	// FallbackModel is the model id that answered instead.
	FallbackModel string
	// SameModel is true when both ids name the same model. A fallback that
	// stayed on the same model proves nothing about availability, so a real
	// switch records false.
	SameModel bool
}

// modelStreamFallback serves one answer, from the primary or from its fallback.
type modelStreamFallback struct {
	primary   ModelEventStream
	primaryID string
	fallback  *ModelEntry
	// open builds the send for the fallback model: its own gate, key and slot.
	open func(ModelEntry) (ModelEventStream, error)
	// record keeps the four facts of a fallback that happened.
	record func(ModelFallbackRecord)

	active   ModelEventStream
	switched bool
	// failure is the primary's failure text, kept verbatim for the record and
	// for the message the turn sees when the fallback fails too.
	failure string
}

// StreamWithModelFallback wraps one send with the fallback its entry names.
//
// A stream without a fallback is returned as it is, so a graph that configures
// none behaves exactly as before.
func StreamWithModelFallback(primary ModelEventStream, primaryID string, fallback *ModelEntry, open func(ModelEntry) (ModelEventStream, error), record func(ModelFallbackRecord)) ModelEventStream {
	if fallback == nil || open == nil {
		return primary
	}
	return &modelStreamFallback{primary: primary, primaryID: primaryID, fallback: fallback, open: open, record: record, active: primary}
}

// Next returns the next event of the answer that is actually being served.
func (stream *modelStreamFallback) Next() (map[string]any, bool) {
	for {
		event, ok := stream.active.Next()
		if !ok {
			return nil, false
		}
		if !stream.switched && stream.isTransportFailure(event) {
			stream.failure = fallbackFailureText(event)
			switched, err := stream.switchToFallback()
			if err != nil {
				return failureEvent(stream.fallback, err.Error()), true
			}
			if switched {
				continue
			}
		}
		if stream.switched && rsiText(event["type"]) == "error" {
			// Neither model answered. The turn fails, and it fails with both
			// reasons: an operator has to be able to see which endpoint broke and
			// that the fallback broke too, instead of a failure that hides half of
			// what happened.
			return combinedFailureEvent(event, stream.primaryID, stream.fallback.Id, stream.failure), true
		}
		return event, true
	}
}

// Result returns the settled message of the answer that was served.
func (stream *modelStreamFallback) Result() map[string]any {
	for {
		if _, ok := stream.Next(); !ok {
			break
		}
	}
	return stream.active.Result()
}

// isTransportFailure reports whether this event ends a send the provider
// boundary broke, before any answer existed.
func (stream *modelStreamFallback) isTransportFailure(event map[string]any) bool {
	if rsiText(event["type"]) != "error" {
		return false
	}
	transport, _ := event["transport"].(bool)
	return transport
}

// switchToFallback opens the fallback send and records what happened. It
// reports false when the fallback cannot even be built, so the caller serves
// the primary's own failure rather than losing it.
func (stream *modelStreamFallback) switchToFallback() (bool, error) {
	stream.switched = true
	next, err := stream.open(*stream.fallback)
	if err != nil {
		return false, errorString(
			"the primary model " + stream.primaryID + " failed at the provider boundary (" + stream.failure +
				"); the fallback " + stream.fallback.Id + " could not be started: " + err.Error())
	}
	stream.active = next
	if stream.record != nil {
		stream.record(ModelFallbackRecord{
			PrimaryModel: stream.primaryID, Error: stream.failure,
			FallbackModel: stream.fallback.Id, SameModel: sameModelEntry(stream.primaryID, *stream.fallback),
		})
	}
	return true, nil
}

// fallbackFailureText is the provider failure as the client reported it. It is
// never rewritten: the text is the evidence of what went wrong.
func fallbackFailureText(event map[string]any) string {
	message := asMap(event["error"])
	if text := rsiText(message["errorMessage"]); text != "" {
		return text
	}
	if text := rsiText(event["reason"]); text != "" {
		return text
	}
	return "the provider boundary failed without a message"
}

// combinedFailureEvent is the failure of a send both models failed: the
// fallback's own event, carrying both reasons in its message.
func combinedFailureEvent(event map[string]any, primaryID, fallbackID, primaryFailure string) map[string]any {
	fallbackFailure := fallbackFailureText(event)
	message := asMap(event["error"])
	message["errorMessage"] = "the primary model " + primaryID + " failed at the provider boundary (" + primaryFailure +
		"); the fallback " + fallbackID + " failed too (" + fallbackFailure + ")"
	// Nothing takes this failure over: it stands as the turn's own failure.
	delete(event, "transport")
	event["error"] = message
	return event
}

// failureEvent is the turn-visible failure when the fallback could not start.
func failureEvent(model *ModelEntry, text string) map[string]any {
	message := &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Provider: model.Provider, Model: model.Id, StopReason: "error",
		ErrorMessage: stringPointer(text), Timestamp: NowMillis(),
	}
	return map[string]any{"type": "error", "reason": "error", "error": asMap(message)}
}

// sameModelEntry reports whether a fallback stayed on the model it started on.
func sameModelEntry(primaryID string, fallback ModelEntry) bool {
	return primaryID == fallback.Id
}
