package mygoauto

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// frontmostPID names the process whose window is in front, as the window
// server sees it. A screen capture of a rectangle proves nothing when another
// app covers it, so callers check this before trusting a PNG.
func frontmostPID() int {
	asn := strings.TrimSpace(strings.TrimSuffix(commandOutput("lsappinfo", "front"), ":"))
	if asn == "" {
		return 0
	}
	info := commandOutput("lsappinfo", "info", "-only", "pid", asn)
	_, after, ok := strings.Cut(info, "pid = ")
	if !ok {
		return 0
	}
	digits := ""
	for _, char := range after {
		if char < '0' || char > '9' {
			break
		}
		digits += string(char)
	}
	pid, err := strconv.Atoi(digits)
	if err != nil {
		return 0
	}
	return pid
}

func commandOutput(name string, args ...string) string {
	output, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return string(output)
}

// Screenshot captures the window's frame rectangle with the system tool, not
// with the app's own capture: the evidence must show what a user would see.
// Capture returns the rectangle, whether our window was in front, and the file.
func (s *Session) Screenshot(path string) (Rect, bool, error) {
	windows, err := s.Windows()
	if err != nil {
		return Rect{}, false, err
	}
	var target *Window
	for index := range windows {
		window := windows[index]
		if window.Kind != "content" || !window.Visible {
			continue
		}
		if target == nil || window.Focused {
			target = &window
		}
	}
	if target == nil {
		return Rect{}, false, errNoWindow
	}
	rect := target.Bounds
	if rect.Width < 1 || rect.Height < 1 {
		return Rect{}, false, fmt.Errorf("mygoauto: window %d has no area on screen (%+v); bring it on screen before capturing", target.ID, rect)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return Rect{}, false, err
	}
	front := frontmostPID()
	frontmost := front == 0 || front == s.appPID()
	args := append([]string{"-x"}, target.Bounds.screenCaptureArgs()...)
	command := exec.Command("/usr/sbin/screencapture", append(args, path)...)
	if output, err := command.CombinedOutput(); err != nil {
		return rect, frontmost, fmt.Errorf("mygoauto: screencapture failed: %w\n%s", err, strings.TrimSpace(string(output)))
	}
	info, err := os.Stat(path)
	if err != nil {
		return rect, frontmost, err
	}
	if info.Size() < 1024 {
		return rect, frontmost, fmt.Errorf("mygoauto: the screenshot is only %d bytes; the window may be off screen", info.Size())
	}
	return rect, frontmost, nil
}

// appPID is the window process of this run: the one we started, else the one
// the run recorded.
func (s *Session) appPID() int {
	if s.app != nil && s.app.Process != nil {
		return s.app.Process.Pid
	}
	if record, err := ReadWindow(s.opts); err == nil {
		return record.AppPID
	}
	return 0
}

func (s *Session) Close(ctx context.Context) error {
	var failures []string
	if s.conn != nil {
		_ = s.conn.close()
		s.conn = nil
	}
	for _, process := range []*exec.Cmd{s.app, s.daemon} {
		if process == nil || process.Process == nil {
			continue
		}
		pid := process.Process.Pid
		if err := process.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
			failures = append(failures, fmt.Sprintf("pid %d: %v", pid, err))
		}
		deadline := time.Now().Add(StopGrace)
		for time.Now().Before(deadline) && processAlive(pid) {
			time.Sleep(100 * time.Millisecond)
		}
		if processAlive(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	if len(failures) > 0 {
		return errors.New("mygoauto: cleanup: " + strings.Join(failures, "; "))
	}
	return nil
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
