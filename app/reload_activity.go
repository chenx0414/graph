package main

import (
	"encoding/json"
	"time"
)

// daemonActivity asks the daemon how much work is in flight. It is the durable
// answer: an operation stays dispatched even when the console looks idle, so a
// build that looked at the UI would still cut a live turn.
type daemonActivity struct {
	console *string
	token   func() string
	client  func(address, token string) apiClient
}

func (a daemonActivity) HasActiveOperation() bool {
	address := ""
	if a.console != nil {
		address = *a.console
	}
	if address == "" {
		// Without a console there is nothing that could be running: a daemon that
		// is not reachable has no operations, and waiting for it would hang a build
		// forever.
		return false
	}
	payload, err := a.client(address, a.token()).get("/api/app/activity")
	if err != nil {
		return false
	}
	var body struct {
		Active int `json:"active"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return false
	}
	return body.Active > 0
}

// reloadGate returns the shell's one gate. Every replacing path asks the same
// object, so a reload held back by one caller is still armed for the next.
func (s *shell) reloadGate() *reloadGate {
	s.gateOnce.Do(func() {
		activity := daemonActivity{
			console: &s.console,
			token:   func() string { return appToken(s.paths.StateDir) },
			client:  func(address, token string) apiClient { return newAPIClient(address, token) },
		}
		s.gate = newReloadGate(activity, execSelf)
	})
	return s.gate
}

// reloadPollInterval is how often a held-back reload looks again. A settled
// operation is noticed within one tick.
const reloadPollInterval = 5 * time.Second
