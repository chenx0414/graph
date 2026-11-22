package main

import (
	"net"
	"strings"
	"testing"
	"time"
)

func deadServerURL(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return "http://" + address
}

func settleUpdates(shell *shellState, done func() bool) {
	for attempt := 0; attempt < 2000; attempt++ {
		shell.updates.drain()
		if done() {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

// A card that cannot reach the daemon used to print the raw error, so the console showed a URL
// and "connection refused" where a person expects a sentence. During a reload that text appeared
// on the fleet card and in the activity card together, which made the console look broken.
func TestAFleetReadFailureDoesNotShowTheTransportError(t *testing.T) {
	shell := &shellState{api: newAPIClient(deadServerURL(t), "")}
	shell.loadFleet()
	settleUpdates(shell, func() bool { return !shell.fleet.loading })
	if shell.fleet.failed == "" {
		t.Fatal("the failure must still be reported")
	}
	for _, leak := range []string{"127.0.0.1", "connection refused", "Get \"http"} {
		if strings.Contains(shell.fleet.failed, leak) {
			t.Fatalf("the card must not show the transport error, got %q", shell.fleet.failed)
		}
	}
}

func TestAnActivityReadFailureDoesNotShowTheTransportError(t *testing.T) {
	shell := &shellState{api: newAPIClient(deadServerURL(t), "")}
	shell.fleet.detail.agentID = "a1"
	shell.refreshFleetDetail(fleetAgent{ID: "a1", ConversationID: "c1"})
	settleUpdates(shell, func() bool { return shell.fleet.detail.failed != "" })
	if shell.fleet.detail.failed == "" {
		t.Fatal("the failure must still be reported")
	}
	for _, leak := range []string{"127.0.0.1", "connection refused"} {
		if strings.Contains(shell.fleet.detail.failed, leak) {
			t.Fatalf("the activity card must not show the transport error, got %q", shell.fleet.detail.failed)
		}
	}
}
