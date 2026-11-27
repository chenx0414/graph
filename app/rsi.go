package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type rsiStatus struct {
	CanRestart     bool `json:"canRestart"`
	PendingRestart *struct {
		ID string `json:"id"`
	} `json:"pendingRestart"`
}

func appToken(stateDir string) string {
	payload, err := os.ReadFile(filepath.Join(stateDir, "app-token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(payload))
}

func pendingRestart(status rsiStatus) (string, bool) {
	if status.PendingRestart == nil || status.PendingRestart.ID == "" || !status.CanRestart {
		return "", false
	}
	return status.PendingRestart.ID, true
}

func appRequest(address, token, path string) (*http.Request, error) {
	request, err := http.NewRequest("GET", strings.TrimSuffix(address, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-graph-app-token", token)
	request.Header.Set("origin", strings.TrimSuffix(address, "/"))
	return request, nil
}

func fetchRsiStatus(address, token string) (rsiStatus, bool) {
	var status rsiStatus
	request, err := appRequest(address, token, "/api/app/rsi/status")
	if err != nil {
		return status, false
	}
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return status, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return status, false
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		return status, false
	}
	return status, true
}

func ackRestart(address, token, id string) bool {
	for attempt := 0; attempt < 5; attempt++ {
		request, err := appRequest(address, token, "/api/app/rsi/restart-ack")
		if err == nil {
			request.Method = "POST"
			request.Header.Set("content-type", "application/json")
			body, _ := json.Marshal(map[string]string{"id": id})
			request.Body = io.NopCloser(bytes.NewReader(body))
			client := &http.Client{Timeout: 5 * time.Second}
			if response, err := client.Do(request); err == nil {
				var answer struct {
					Cleared bool `json:"cleared"`
				}
				ok := response.StatusCode == http.StatusOK && json.NewDecoder(response.Body).Decode(&answer) == nil && answer.Cleared
				response.Body.Close()
				if ok {
					return true
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// errDaemonRestartRefused reports that the daemon did not come back; the caller
// leaves the gate armed so the next poll tries again.
var errDaemonRestartRefused = errors.New("the daemon refused the restart")

func (s *shell) watchRsi() {
	for range time.Tick(3 * time.Second) {
		s.pollRsi()
	}
}

func (s *shell) pollRsi() {
	if s.console == "" || s.restarting.Load() {
		return
	}
	status, ok := fetchRsiStatus(s.console, appToken(s.paths.StateDir))
	if !ok {
		return
	}
	id, pending := pendingRestart(status)
	if !pending || id == s.rsiTried {
		return
	}
	s.restarting.Store(true)
	// An RSI change replaces the daemon, which ends whatever operation is running.
	// The gate holds it until the work settles, so the change lands afterwards
	// instead of cutting a live turn.
	applied := false
	s.reloadGate().run(func() error {
		restarted, _ := s.daemon.restart(true)
		if !restarted {
			return errDaemonRestartRefused
		}
		applied = true
		return nil
	})
	if !applied {
		s.restarting.Store(false)
		return
	}
	s.rsiTried = id
	if info, ok := s.paths.ReadConsole(); ok {
		s.console = info.URL
	}
	confirmed := ackRestart(s.console, appToken(s.paths.StateDir), id)
	s.restarting.Store(false)
	if !confirmed {
		notify("RSI 重载未能确认", "新的代码已在跑，但握手没有回执，宿主不会自动唤醒主控。")
	}
	if s.chat != nil {
		if active := s.chat.active(); active != nil {
			active.refresh()
		}
		s.chat.frame()
	}
}
