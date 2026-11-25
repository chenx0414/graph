package graph

type ModelFallbackRecord struct {
	PrimaryModel  string
	Error         string
	FallbackModel string
	SameModel     bool
}

type modelStreamFallback struct {
	primary   ModelEventStream
	primaryID string
	fallback  *ModelEntry
	open      func(ModelEntry) (ModelEventStream, error)
	record    func(ModelFallbackRecord)

	active   ModelEventStream
	switched bool
	failure  string
}

func StreamWithModelFallback(primary ModelEventStream, primaryID string, fallback *ModelEntry, open func(ModelEntry) (ModelEventStream, error), record func(ModelFallbackRecord)) ModelEventStream {
	if fallback == nil || open == nil {
		return primary
	}
	return &modelStreamFallback{primary: primary, primaryID: primaryID, fallback: fallback, open: open, record: record, active: primary}
}

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
			return combinedFailureEvent(event, stream.primaryID, stream.fallback.Id, stream.failure), true
		}
		return event, true
	}
}

func (stream *modelStreamFallback) Result() map[string]any {
	for {
		if _, ok := stream.Next(); !ok {
			break
		}
	}
	return stream.active.Result()
}

func (stream *modelStreamFallback) isTransportFailure(event map[string]any) bool {
	if rsiText(event["type"]) != "error" {
		return false
	}
	transport, _ := event["transport"].(bool)
	return transport
}

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

func combinedFailureEvent(event map[string]any, primaryID, fallbackID, primaryFailure string) map[string]any {
	fallbackFailure := fallbackFailureText(event)
	message := asMap(event["error"])
	message["errorMessage"] = "the primary model " + primaryID + " failed at the provider boundary (" + primaryFailure +
		"); the fallback " + fallbackID + " failed too (" + fallbackFailure + ")"
	delete(event, "transport")
	event["error"] = message
	return event
}

func failureEvent(model *ModelEntry, text string) map[string]any {
	message := &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Provider: model.Provider, Model: model.Id, StopReason: "error",
		ErrorMessage: stringPointer(text), Timestamp: NowMillis(),
	}
	return map[string]any{"type": "error", "reason": "error", "error": asMap(message)}
}

func sameModelEntry(primaryID string, fallback ModelEntry) bool {
	return primaryID == fallback.Id
}
