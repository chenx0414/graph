package main

import (
	"encoding/json"
	"time"
)

type daemonActivity struct {
	console  func() string
	fromDisk func() (string, bool)
	token    func() string
	client   func(address, token string) apiClient
}

func (a daemonActivity) HasActiveOperation() bool {
	address := ""
	if a.console != nil {
		address = a.console()
	}
	if address == "" {
		// A shell that has not read its console yet knows nothing about the work
		// in flight, and "I do not know" must not read as "nothing is running": the
		// first thing a freshly exec'd GUI does is restart a daemon it judges stale,
		// which ends the turn that survived the rebuild.
		if a.fromDisk == nil {
			return false
		}
		found, ok := a.fromDisk()
		if !ok {
			return false
		}
		address = found
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
	if s.gate != nil {
		return s.gate
	}
	s.gateOnce.Do(func() {
		activity := daemonActivity{
			console:  s.consoleURL,
			fromDisk: s.consoleOnDisk,
			token:    func() string { return appToken(s.paths.StateDir) },
			client:   func(address, token string) apiClient { return newAPIClient(address, token) },
		}
		s.gate = newReloadGate(activity, execSelf)
	})
	return s.gate
}

const reloadPollInterval = 5 * time.Second

// consoleOnDisk reads the address the last run recorded, so a gate built before this
// shell talked to a daemon can still ask whether work is running.
func (s *shell) consoleOnDisk() (string, bool) {
	info, ok := s.paths.ReadConsole()
	if !ok || info.URL == "" {
		return "", false
	}
	return info.URL, true
}
