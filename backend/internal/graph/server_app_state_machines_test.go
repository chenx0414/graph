package graph

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStateMachinesEndpointPublishesEveryMachine(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&GraphApp{}).serveStateMachines(recorder, httptest.NewRequest(http.MethodGet, "/api/state-machines", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d", recorder.Code)
	}
	var view stateMachinesView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("payload does not parse: %v", err)
	}
	if view.Version != 1 || len(view.Machines) == 0 {
		t.Fatalf("view holds version %d and %d machines", view.Version, len(view.Machines))
	}
	seen := map[string]bool{}
	for _, machine := range view.Machines {
		seen[machine.ID] = true
		for _, state := range machine.States {
			if state.Name == "" || state.Label == "" {
				t.Fatalf("%s publishes a state without a label: %+v", machine.ID, state)
			}
		}
	}
	for _, want := range []string{"task.phase", "node.status", "execution.state", "queue.state", "fleet.agent_status"} {
		if !seen[want] {
			t.Fatalf("%s is missing from the published registry", want)
		}
	}
}
