package appinstance

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type LaunchResult struct {
	AppPID    int    `json:"appPid"`
	DaemonPID int    `json:"daemonPid"`
	URL       string `json:"url"`
	WindowID  string `json:"windowId"`
	Mode      string `json:"mode"`
}

type Status struct {
	Root          string   `json:"root"`
	AppPID        int      `json:"appPid"`
	AppAlive      bool     `json:"appAlive"`
	DaemonPID     int      `json:"daemonPid"`
	DaemonAlive   bool     `json:"daemonAlive"`
	URL           string   `json:"url,omitempty"`
	Healthy       bool     `json:"healthy"`
	WindowID      string   `json:"windowId,omitempty"`
	WindowVisible bool     `json:"windowVisible"`
	Mode          string   `json:"mode"`
	Isolated      bool     `json:"isolated"`
	Problems      []string `json:"problems,omitempty"`
}

func (i *Instance) LaunchUI(timeout time.Duration) (LaunchResult, error) {
	if err := i.prepare(); err != nil {
		return LaunchResult{}, err
	}
	logFile, err := os.OpenFile(i.AppLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return LaunchResult{}, err
	}
	defer logFile.Close()
	command := exec.Command(i.AppPath())
	command.Env = i.envForChild()
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return LaunchResult{}, fmt.Errorf("cannot start the isolated Graph window: %w", err)
	}
	i.AppPID = command.Process.Pid
	_ = command.Process.Release()
	if err := i.Save(); err != nil {
		return LaunchResult{}, err
	}
	if err := i.waitReady(timeout); err != nil {
		return LaunchResult{}, err
	}
	window, err := i.waitWindow(timeout)
	if err != nil {
		return LaunchResult{}, err
	}
	return LaunchResult{
		AppPID:    i.AppPID,
		DaemonPID: i.DaemonPID,
		URL:       i.URL,
		WindowID:  window.ID,
		Mode:      i.Mode,
	}, nil
}

func (i *Instance) LaunchWindowOnly(timeout time.Duration) (LaunchResult, error) {
	if err := i.prepare(); err != nil {
		return LaunchResult{}, err
	}
	if console, err := i.readConsole(); err == nil {
		i.URL = console.URL
		i.DaemonPID = console.PID
	} else {
		return LaunchResult{}, fmt.Errorf("no daemon has published %s; run: verify-graph launch first", i.ConsolePath())
	}
	logFile, err := os.OpenFile(i.AppLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return LaunchResult{}, err
	}
	defer logFile.Close()
	command := exec.Command(i.AppPath())
	command.Env = i.envForChild()
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return LaunchResult{}, fmt.Errorf("cannot start the isolated Graph window: %w", err)
	}
	i.AppPID = command.Process.Pid
	_ = command.Process.Release()
	if err := i.Save(); err != nil {
		return LaunchResult{}, err
	}
	window, err := i.waitWindow(timeout)
	if err != nil {
		return LaunchResult{}, err
	}
	return LaunchResult{AppPID: i.AppPID, DaemonPID: i.DaemonPID, URL: i.URL, WindowID: window.ID, Mode: i.Mode}, nil
}

func (i *Instance) LaunchDaemon(timeout time.Duration) (LaunchResult, error) {
	if err := i.prepare(); err != nil {
		return LaunchResult{}, err
	}
	daemon := filepath.Join(i.BinDir(), "graphd")
	args := []string{
		"--state-dir", i.StateDir(),
		"--graph-home", i.GraphHome(),
		"--config", i.ConfigPath(),
		"--application-root", i.Repo,
		"--port", "0",
	}
	if i.Mode == "execute" {
		args = append(args, "--execute")
	} else {
		args = append(args, "--view-only")
	}
	logFile, err := os.OpenFile(i.DaemonLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return LaunchResult{}, err
	}
	defer logFile.Close()
	command := exec.Command(daemon, args...)
	command.Env = i.envForChild()
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return LaunchResult{}, fmt.Errorf("cannot start graphd: %w", err)
	}
	i.DaemonPID = command.Process.Pid
	_ = command.Process.Release()
	if err := i.Save(); err != nil {
		return LaunchResult{}, err
	}
	if err := i.waitReady(timeout); err != nil {
		return LaunchResult{}, err
	}
	return LaunchResult{DaemonPID: i.DaemonPID, URL: i.URL, Mode: i.Mode}, nil
}

func (i *Instance) waitReady(timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if console, err := i.readConsole(); err == nil && console.URL != "" {
			i.URL = console.URL
			if console.PID > 0 {
				i.DaemonPID = console.PID
			}
			i.StartedAt = console.StartedAt
			_ = i.Save()
			if i.API().Healthy() {
				return nil
			}
		}
		if i.AppPID > 0 && !ProcessAlive(i.AppPID) && i.DaemonPID == 0 {
			return fmt.Errorf("the isolated Graph window exited before its daemon was ready; read %s", i.AppLog())
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("the isolated daemon did not become reachable within %s; read %s", timeout, i.AppLog())
}

func (i *Instance) waitWindow(timeout time.Duration) (Window, error) {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		window, err := i.DesktopClient().WindowForPID(i.AppPID)
		if err == nil && window.Visible {
			return window, nil
		}
		lastErr = err
		time.Sleep(400 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no visible window for pid %d", i.AppPID)
	}
	return Window{}, fmt.Errorf("the isolated window never became visible: %w", lastErr)
}

type console struct {
	URL       string `json:"url"`
	PID       int    `json:"pid"`
	Mode      string `json:"mode"`
	StartedAt string `json:"startedAt"`
}

func (i *Instance) readConsole() (console, error) {
	payload, err := os.ReadFile(i.ConsolePath())
	if err != nil {
		return console{}, err
	}
	var value struct {
		URL       string      `json:"url"`
		PID       int         `json:"pid"`
		Mode      string      `json:"mode"`
		StartedAt json.Number `json:"startedAt"`
	}
	if err := json.Unmarshal(payload, &value); err != nil {
		return console{}, err
	}
	if !strings.HasPrefix(value.URL, "http") {
		return console{}, fmt.Errorf("console.json has no usable url: %s", string(payload))
	}
	return console{URL: value.URL, PID: value.PID, Mode: value.Mode, StartedAt: value.StartedAt.String()}, nil
}

func (i *Instance) Status() Status {
	status := Status{
		Root:      i.Options.Root,
		AppPID:    i.AppPID,
		AppAlive:  ProcessAlive(i.AppPID),
		DaemonPID: i.DaemonPID,
		Mode:      i.Mode,
	}
	if console, err := i.readConsole(); err == nil {
		status.URL = console.URL
		if status.DaemonPID == 0 {
			status.DaemonPID = console.PID
		}
		status.DaemonAlive = ProcessAlive(status.DaemonPID)
	}
	if status.URL != "" {
		status.Healthy = i.API().Healthy()
	}
	status.Isolated = strings.HasPrefix(status.URL, "http://127.0.0.1:")
	if status.AppAlive {
		if window, err := i.DesktopClient().WindowForPID(i.AppPID); err == nil {
			status.WindowID = window.ID
			status.WindowVisible = window.Visible
		}
	}
	if !status.AppAlive && !status.DaemonAlive {
		status.Problems = append(status.Problems, "nothing from this run is alive; start one with verify-graph launch")
	}
	if status.DaemonAlive && !status.Healthy {
		status.Problems = append(status.Problems, "the daemon process is alive but /api/health does not answer; read "+i.AppLog())
	}
	if status.AppAlive && status.WindowID == "" {
		status.Problems = append(status.Problems, "the window process is alive but agent-desktop sees no window for it")
	}
	return status
}

func (i *Instance) Stop() []string {
	stopped := []string{}
	if i.AppPID > 0 {
		if result, err := stopProcess(i.AppPID, i.Options.Root); err == nil {
			stopped = append(stopped, fmt.Sprintf("app pid %d: %s", i.AppPID, result))
			i.AppPID = 0
		} else {
			stopped = append(stopped, fmt.Sprintf("app pid %d: %v", i.AppPID, err))
		}
	}
	if i.DaemonPID > 0 {
		if result, err := stopProcess(i.DaemonPID, i.Options.Root); err == nil {
			stopped = append(stopped, fmt.Sprintf("daemon pid %d: %s", i.DaemonPID, result))
			i.DaemonPID = 0
		} else {
			stopped = append(stopped, fmt.Sprintf("daemon pid %d: %v", i.DaemonPID, err))
		}
	}
	_ = i.Save()
	return stopped
}

func stopProcess(pid int, marker string) (string, error) {
	if pid <= 0 || !ProcessAlive(pid) {
		return "already stopped", nil
	}
	command := ProcessCommand(pid)
	if marker == "" || !strings.Contains(command, marker) {
		return "", fmt.Errorf("refusing to signal pid %d: its command line (%s) does not mention %s", pid, command, marker)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && err != syscall.ESRCH {
		return "", err
	}
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			return "stopped with SIGTERM", nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	return "stopped with SIGKILL after the 7s bound", nil
}

func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func ProcessCommand(pid int) string {
	out, err := exec.Command("ps", "-o", "command=", "-p", fmt.Sprint(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (i *Instance) Window(windowID string) (Window, error) {
	if windowID != "" {
		windows, err := i.desktop.Windows()
		if err != nil {
			return Window{}, err
		}
		for _, window := range windows {
			if window.ID == windowID {
				return window, nil
			}
		}
		return Window{}, fmt.Errorf("window %s is gone; run: verify-graph ui window open", windowID)
	}
	if i.AppPID <= 0 {
		return Window{}, fmt.Errorf("this run has no window process; run: verify-graph ui window open")
	}
	return i.desktop.WindowForPID(i.AppPID)
}

func (i *Instance) Screenshot(windowID, path string) error {
	window, err := i.Window(windowID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return i.desktop.ScreenshotRect(window, path)
}
