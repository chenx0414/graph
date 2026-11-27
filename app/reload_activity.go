package main

import (
	"encoding/json"
	"time"
)

type daemonActivity struct {
	console func() string
	token   func() string
	client  func(address, token string) apiClient
}

func (a daemonActivity) HasActiveOperation() bool {
	address := ""
	if a.console != nil {
		address = a.console()
	}
	if address == "" {
		// Nothing can be running if nothing answers.
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

func (s *shell) reloadGate() *reloadGate {
	s.gateOnce.Do(func() {
		activity := daemonActivity{
			console: s.consoleURL,
			token:   func() string { return appToken(s.paths.StateDir) },
			client:  func(address, token string) apiClient { return newAPIClient(address, token) },
		}
		s.gate = newReloadGate(activity, execSelf)
	})
	return s.gate
}

const reloadPollInterval = 5 * time.Second
