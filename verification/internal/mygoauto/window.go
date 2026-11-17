package mygoauto

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// WindowRecord names the window process a run started, so a later command can
// stop exactly that process and nothing else.
type WindowRecord struct {
	RunDir    string    `json:"runDir"`
	AppPID    int       `json:"appPid"`
	AppStart  string    `json:"appStart"`
	Binary    string    `json:"binary"`
	Socket    string    `json:"socket"`
	WindowID  int       `json:"windowId"`
	BuildSHA  string    `json:"buildSha256"`
	StartedAt time.Time `json:"startedAt"`
}

func (o Options) windowRecordPath() string { return filepath.Join(o.RunDir, "ui-motion.json") }

// SaveWindow writes the record of the window this session started.
func (s *Session) SaveWindow() (WindowRecord, error) {
	status := s.Status()
	record := WindowRecord{
		RunDir: s.opts.RunDir, AppPID: status.AppPID, AppStart: processStart(status.AppPID),
		Binary: s.opts.appBinary(), Socket: s.opts.socketPath(), WindowID: s.window,
		BuildSHA: s.record.SHA256, StartedAt: time.Now().UTC(),
	}
	payload, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return record, err
	}
	return record, os.WriteFile(s.opts.windowRecordPath(), append(payload, '\n'), 0o644)
}

// ReadWindow reads the record of the window a run started.
func ReadWindow(opts Options) (WindowRecord, error) {
	var record WindowRecord
	payload, err := os.ReadFile(opts.windowRecordPath())
	if err != nil {
		return record, fmt.Errorf("mygoauto: no window recorded for this run; start one with: verify-graph ui motion open --run %s", filepath.Base(opts.RunDir))
	}
	if err := json.Unmarshal(payload, &record); err != nil {
		return record, err
	}
	return record, nil
}

// StopWindow stops the process the record names, after checking that the pid is
// still the same process: a recycled pid is never signalled.
func StopWindow(record WindowRecord) error {
	if record.AppPID <= 0 {
		return nil
	}
	if !processAlive(record.AppPID) {
		return nil
	}
	if start := processStart(record.AppPID); record.AppStart != "" && start != "" && start != record.AppStart {
		return fmt.Errorf("mygoauto: refusing to stop pid %d: it is not the window this run started", record.AppPID)
	}
	if command := processCommand(record.AppPID); record.Binary != "" && command != "" && !strings.Contains(command, record.Binary) {
		return fmt.Errorf("mygoauto: refusing to stop pid %d: it runs %s, not %s", record.AppPID, command, record.Binary)
	}
	_ = syscall.Kill(record.AppPID, syscall.SIGTERM)
	deadline := time.Now().Add(StopGrace)
	for time.Now().Before(deadline) && processAlive(record.AppPID) {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(record.AppPID) {
		_ = syscall.Kill(record.AppPID, syscall.SIGKILL)
	}
	return nil
}

func processStart(pid int) string {
	if pid <= 0 {
		return ""
	}
	output, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func processCommand(pid int) string {
	if pid <= 0 {
		return ""
	}
	output, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
