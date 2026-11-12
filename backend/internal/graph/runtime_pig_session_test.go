package graph

import "testing"

func TestPigSessionStreamPrefersTheExplicitOption(t *testing.T) {
	called := ""
	explicit := func(any, map[string]any, map[string]any) (ModelEventStream, error) {
		called = "explicit"
		return nil, nil
	}
	requestStream := func(any, map[string]any, map[string]any) (ModelEventStream, error) {
		called = "request"
		return nil, nil
	}
	stream := pigSessionStream(pigSessionOpenOptions{Stream: explicit, Request: AgentSessionRequest{Stream: requestStream}})
	_, _ = stream(nil, nil, nil)
	if called != "explicit" {
		t.Fatalf("stream selection called %q", called)
	}
}

func TestPigSessionStreamFallsBackToTheRequest(t *testing.T) {
	called := ""
	requestStream := func(any, map[string]any, map[string]any) (ModelEventStream, error) {
		called = "request"
		return nil, nil
	}
	stream := pigSessionStream(pigSessionOpenOptions{Request: AgentSessionRequest{Stream: requestStream}})
	_, _ = stream(nil, nil, nil)
	if called != "request" {
		t.Fatalf("stream selection called %q", called)
	}
}
