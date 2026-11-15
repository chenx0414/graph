package graph

import (
	"testing"
	"time"
)

func TestTheGraphHostPollsFastOnlyWhileWorkIsDispatched(t *testing.T) {
	if delay := graphDriveDelay(0); delay != 500*time.Millisecond {
		t.Fatalf("an idle pump must back off instead of scanning every loop, got %s", delay)
	}
	if delay := graphDriveDelay(1); delay != 20*time.Millisecond {
		t.Fatalf("dispatched work must keep the next pump quick, got %s", delay)
	}
}
