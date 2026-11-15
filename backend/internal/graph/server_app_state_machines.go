package graph

import (
	"net/http"

	"github.com/chenx0414/graph/backend/statemachine"
)

type stateMachinesView struct {
	Version  int                    `json:"version"`
	Machines []statemachine.Machine `json:"machines"`
}

func stateMachinesPayload() stateMachinesView {
	return stateMachinesView{Version: statemachine.RegistryVersion, Machines: statemachine.All()}
}

func (app *GraphApp) serveStateMachines(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, stateMachinesPayload())
}
