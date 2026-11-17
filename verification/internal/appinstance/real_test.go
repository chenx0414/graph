package appinstance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "..", "app", "main.go")); err == nil {
				return filepath.Clean(filepath.Join(dir, ".."))
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("cannot find the repository root")
		}
		dir = parent
	}
}

func userLaunchAgent(t *testing.T) (string, string) {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(home, "Library", "LaunchAgents", "dev.graph.daemon.plist")
	return plist, FileDigest(plist)
}

func TestRealIsolatedWindowDrive(t *testing.T) {
	if os.Getenv("VERIFY_REAL") != "1" {
		t.Skip("set VERIFY_REAL=1 to launch a real isolated Graph window and drive it")
	}
	repo := repoRoot(t)
	root := filepath.Join(repo, "verification", ".run", "real-"+NewSuffix())
	evidence := os.Getenv("VERIFY_REAL_EVIDENCE")
	instance, err := New(Options{Repo: repo, Root: root, Mode: "view", EvidenceDirPath: evidence})
	if err != nil {
		t.Fatal(err)
	}
	desktop := instance.DesktopClient()
	if err := desktop.Available(); err != nil {
		t.Fatalf("agent-desktop: %v", err)
	}
	state, err := desktop.Permission()
	if err != nil {
		t.Fatalf("permissions: %v", err)
	}
	if state != "granted" {
		t.Skipf("the accessibility grant is %q; a host context must grant it before a real drive", state)
	}
	plistPath, plistBefore := userLaunchAgent(t)

	launched, err := instance.LaunchUI(90 * time.Second)
	if err != nil {
		instance.Stop()
		t.Fatalf("launch: %v", err)
	}
	defer func() {
		for _, line := range instance.Stop() {
			t.Logf("stop: %s", line)
		}
	}()
	t.Logf("launched pid %d, daemon %d, url %s, window %s", launched.AppPID, launched.DaemonPID, launched.URL, launched.WindowID)
	if !strings.HasPrefix(launched.URL, "http://127.0.0.1:") {
		t.Fatalf("the isolated daemon must bind loopback only, got %s", launched.URL)
	}
	if !strings.Contains(launched.URL, instance.StateDir()) && launched.DaemonPID == 0 {
		t.Fatalf("no daemon pid for the isolated run: %+v", launched)
	}

	health, err := instance.API().Do("GET", "/api/health", nil)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	startup, err := instance.API().Do("GET", "/api/startup", nil)
	if err != nil {
		t.Fatalf("startup: %v", err)
	}
	if check := startup.Assert("api.startup", 200, "mode", "configured"); !check.OK {
		t.Fatalf("%s: %s (%s)", check.ID, check.Actual, check.Hint)
	}
	written := []string{}
	for name, payload := range map[string]any{
		"api-health.json":  health,
		"api-startup.json": startup,
	} {
		raw, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		artifact, err := instance.WriteEvidence(name, raw)
		if err != nil {
			t.Fatalf("evidence %s: %v", name, err)
		}
		written = append(written, artifact.Path)
		t.Logf("evidence %s sha256=%s", artifact.Path, artifact.SHA256[:16])
	}

	window, err := desktop.WindowForPID(instance.AppPID)
	if err != nil {
		t.Fatalf("window for our pid: %v", err)
	}
	if !window.Visible {
		t.Fatalf("the isolated window must be visible to be driven, got %+v", window)
	}
	screenshot := instance.Evidence("window-before.png")
	if err := desktop.ScreenshotRect(window, screenshot); err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	info, err := os.Stat(screenshot)
	if err != nil || info.Size() < 1024 {
		t.Fatalf("the screenshot must be a real capture, got %v (%d bytes)", err, sizeOf(screenshot))
	}
	t.Logf("screenshot %s (%d bytes)", screenshot, info.Size())

	result, artifacts, err := instance.ClickAndProve(window, "洞察", "洞察概览", 40*time.Second)
	if err != nil {
		t.Fatalf("drive: %v", err)
	}
	if !result.OK {
		t.Fatalf("clicking 洞察 must open the insights pane: expected %q, actual %q, hint %q",
			result.Expected, result.Actual, result.Hint)
	}
	for _, artifact := range artifacts {
		t.Logf("evidence %s (%s, %d bytes)", artifact.Path, artifact.Kind, artifact.Bytes)
	}

	whiteboard := instance.WhiteboardPath()
	payload, err := os.ReadFile(whiteboard)
	if err != nil {
		t.Fatalf("the click must reach the product's own whiteboard state: %v", err)
	}
	if !strings.Contains(string(payload), "洞察概览") {
		t.Fatalf("whiteboard.json does not carry the insights page after the click")
	}
	if artifact, err := instance.WriteEvidence("whiteboard.json", payload); err == nil {
		t.Logf("evidence %s sha256=%s", artifact.Path, artifact.SHA256[:16])
	}

	status := instance.Status()
	if !status.Healthy || !status.WindowVisible {
		t.Fatalf("a driven instance must report healthy with a visible window: %+v", status)
	}

	_, plistAfter := userLaunchAgent(t)
	if plistBefore != plistAfter {
		t.Fatalf("the isolated run changed the user's launch agent (%s -> %s)", plistBefore[:16], plistAfter[:16])
	}
	if _, err := os.Stat(plistPath); err != nil {
		t.Fatalf("the user's launch agent must survive the run untouched: %v", err)
	}
	t.Logf("the user launch agent is unchanged (sha256 %s)", plistBefore[:16])
}

func sizeOf(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return info.Size()
}
