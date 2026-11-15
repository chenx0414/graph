package main

import "testing"

func TestTrajectoryRequestTotalIncludesTheSkippedPrefix(t *testing.T) {
	data := &conversationTrajectory{RequestOffset: 50005, Requests: make([]trajectoryRequest, 60)}
	if total := trajectoryRequestTotal(data); total != 50065 {
		t.Fatalf("the header must count the skipped requests too, got %d", total)
	}
	if total := trajectoryRequestTotal(nil); total != 0 {
		t.Fatalf("a missing trajectory has no requests, got %d", total)
	}
}
