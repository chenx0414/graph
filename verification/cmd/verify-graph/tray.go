package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"graph/verification/internal/appinstance"
)

// Surface journeys prove a shell surface a window journey cannot see: F-15's
// menu bar extra is a WindowManager popup, not part of the app's content window.
// The runner observes the surface agent-desktop reports for this run's window
// process, clicks only the unnamed menu-bar-extra root (never a named item such
// as 退出 Graph), and leaves an accessibility dump plus a PNG of the popup.

type surfaceSession struct {
	instance     *appinstance.Instance
	desktop      *appinstance.Desktop
	window       appinstance.Window
	focusProblem string
	launched     bool
}

func ensureSurfaceSession(p paths, meta runMeta, timeout time.Duration) (*surfaceSession, error) {
	instance, err := windowInstance(p, meta)
	if err != nil {
		return nil, err
	}
	if err := instance.DesktopClient().Available(); err != nil {
		return nil, fmt.Errorf("agent-desktop is not available: %w", err)
	}
	session := &surfaceSession{instance: instance, desktop: instance.DesktopClient()}
	if instance.AppPID > 0 && appinstance.ProcessAlive(instance.AppPID) {
		if window, err := instance.DesktopClient().WindowForPID(instance.AppPID); err == nil {
			session.window = window
			session.focusProblem = focusBestEffort(instance.DesktopClient(), window.ID)
			return session, nil
		}
	}
	launched, err := instance.LaunchWindowOnly(timeout)
	if err != nil {
		return nil, fmt.Errorf("cannot open the run's window for its shell surface: %w", err)
	}
	window, err := instance.Window(launched.WindowID)
	if err != nil {
		return nil, fmt.Errorf("the window opened but cannot be resolved: %w", err)
	}
	session.window = window
	session.focusProblem = focusBestEffort(instance.DesktopClient(), window.ID)
	session.launched = true
	return session, nil
}

// focusBestEffort tries to bring the run's window forward, but never fails the
// journey: the surface snapshot and its menu press are scoped by window id, and
// the menu bar strip is visible even when the window is not frontmost. A focus
// refusal is recorded as a warning so the evidence says so.
func focusBestEffort(desktop *appinstance.Desktop, windowID string) string {
	deadline := time.Now().Add(15 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		if err := desktop.FocusWindow(windowID); err == nil {
			return ""
		} else {
			last = err
		}
		time.Sleep(300 * time.Millisecond)
	}
	return "window focus did not settle: " + last.Error()
}

func (s *surfaceSession) Close() {
	if s == nil || s.instance == nil || !s.launched {
		return
	}
	s.instance.StopAppWindow()
}

func (s *surfaceSession) appName() (string, error) {
	return s.desktop.AppNameForPID(s.instance.AppPID)
}

func runJourneySurface(p paths, meta runMeta, value journey, outDir string, existing *windowSession) journeyResult {
	result := journeyResult{OK: true, Lane: "surface"}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	resultPath := filepath.Join(outDir, "result.json")
	write := func() {
		raw, _ := json.MarshalIndent(result, "", "  ")
		_ = os.WriteFile(resultPath, raw, 0o644)
	}
	var session *surfaceSession
	if existing != nil {
		session = &surfaceSession{instance: existing.instance, desktop: existing.desktop, window: existing.window}
	} else {
		opened, err := ensureSurfaceSession(p, meta, 120*time.Second)
		if err != nil {
			result.OK = false
			result.Error = err.Error()
			write()
			return result
		}
		session = opened
		defer session.Close()
	}
	if session.focusProblem != "" {
		result.Output = session.focusProblem
	}
	app := session.window.App
	if app == "" {
		if resolved, err := session.appName(); err == nil {
			app = resolved
		}
	}
	if app == "" {
		app = "unknown"
	}
	surface := firstNonEmpty(value.Surface, "menu-bar-extras")
	var snap appinstance.SurfaceSnapshot
	refresh := func() string {
		current, snapshotErr := session.desktop.SnapshotSurfaceWindow(session.window, surface)
		if snapshotErr != nil {
			return snapshotErr.Error()
		}
		snap = current
		return ""
	}
	if problem := refresh(); problem != "" {
		result.OK = false
		result.Error = "cannot read surface " + surface + " for " + app + ": " + problem
		write()
		return result
	}
	fail := func(index int, verb, detail string) journeyResult {
		result.OK = false
		result.Error = fmt.Sprintf("step %d (%s): %s", index+1, verb, detail)
		write()
		return result
	}
	openedMenu := false
	for index, current := range value.Steps {
		outcome := stepOutcome{Index: index + 1, Verb: current.Verb, OK: true}
		timeout := 8 * time.Second
		if current.TimeoutMs > 0 {
			timeout = time.Duration(current.TimeoutMs) * time.Millisecond
		}
		switch current.Verb {
		case "frame":
			if problem := refresh(); problem != "" {
				return fail(index, current.Verb, "cannot read the surface: "+problem)
			}
		case "open":
			deadline := time.Now().Add(timeout)
			problem := ""
			for time.Now().Before(deadline) {
				if readErr := refresh(); readErr != "" {
					problem = "cannot read " + surface + ": " + readErr
				} else if openErr := openSurfaceMenu(session.desktop, snap); openErr != "" {
					problem = openErr
				} else {
					problem = ""
					break
				}
				time.Sleep(250 * time.Millisecond)
			}
			if problem != "" {
				return fail(index, current.Verb, fmt.Sprintf("cannot open %s within %s: %s", surface, timeout, problem))
			}
			openedMenu = true
			for time.Now().Before(deadline) {
				if refreshErr := refresh(); refreshErr == "" && snap.Contains("打开 Graph") {
					break
				}
				time.Sleep(200 * time.Millisecond)
			}
			outcome.Detail = "clicked the menu bar extra of " + app
		case "waitText":
			deadline := time.Now().Add(timeout)
			seen := false
			for time.Now().Before(deadline) {
				if problem := refresh(); problem == "" && snap.Contains(current.Text) {
					seen = true
					break
				}
				time.Sleep(200 * time.Millisecond)
			}
			if !seen {
				return fail(index, current.Verb, fmt.Sprintf("text %q did not appear on surface %s within %s; the surface shows: %s", current.Text, surface, timeout, strings.Join(snap.Names(), " | ")))
			}
			outcome.Detail = "visible: " + current.Text
		case "assertText", "assertSurfaceText":
			if problem := refresh(); problem != "" {
				return fail(index, current.Verb, "cannot read the surface: "+problem)
			}
			if !snap.Contains(current.Text) {
				return fail(index, current.Verb, fmt.Sprintf("expected text %q on surface %s; the surface shows: %s", current.Text, surface, strings.Join(snap.Names(), " | ")))
			}
			outcome.Detail = "visible: " + current.Text
		case "assertNoText":
			if problem := refresh(); problem != "" {
				return fail(index, current.Verb, "cannot read the surface: "+problem)
			}
			if snap.Contains(current.Text) {
				return fail(index, current.Verb, fmt.Sprintf("unexpected text %q is on surface %s", current.Text, surface))
			}
		case "assertAccess":
			if problem := refresh(); problem != "" {
				return fail(index, current.Verb, "cannot read the surface: "+problem)
			}
			node, found := findAccess(snap.Snapshot, current.Name, current.Role)
			if !found {
				return fail(index, current.Verb, fmt.Sprintf("%q is not exposed with role %q on surface %s; the surface shows: %s", current.Name, current.Role, surface, strings.Join(snap.Names(), " | ")))
			}
			result.Access = append(result.Access, accessDump{Name: node.Name, Role: node.Role, Value: node.Value})
			outcome.Detail = "exposed as " + firstNonEmpty(node.Role, current.Role)
		case "screenshot":
			name := current.Path
			if name == "" {
				name = fmt.Sprintf("surface-%02d.png", index+1)
			}
			path := filepath.Join(outDir, name)
			if problem := refresh(); problem != "" {
				return fail(index, current.Verb, "cannot read the surface before capturing it: "+problem)
			}
			if snap.Window.ID == "" {
				return fail(index, current.Verb, fmt.Sprintf("surface %s reported no window to capture", surface))
			}
			rect := snap.ContentRect()
			if rect.Width <= 0 || rect.Height <= 0 {
				return fail(index, current.Verb, fmt.Sprintf("surface %s exposed no element with real bounds to capture", surface))
			}
			if shotErr := session.desktop.ScreenshotBounds(rect, path); shotErr != nil {
				return fail(index, current.Verb, "cannot capture surface "+surface+": "+shotErr.Error())
			}
			result.Frames = append(result.Frames, path)
			outcome.Detail = fmt.Sprintf("%s (%s, %dx%d at %d,%d)", path, snap.SurfaceLabel(), int(rect.Width), int(rect.Height), int(rect.X), int(rect.Y))
		default:
			return fail(index, current.Verb, fmt.Sprintf("the surface lane does not implement %q; use a window or headless journey for this step", current.Verb))
		}
		result.Steps = append(result.Steps, outcome)
	}
	result.Texts = snap.Names()
	if _, err := session.desktop.Notifications(app); err != nil {
		result.Output = "notification center read skipped: " + err.Error()
	} else {
		raw, _ := session.desktop.Notifications(app)
		path := filepath.Join(outDir, "notifications.json")
		_ = os.WriteFile(path, raw, 0o644)
	}
	surfaceRaw, _ := json.MarshalIndent(map[string]any{
		"app": app, "surface": surface, "window": snap.Window, "elements": snap.Nodes,
	}, "", "  ")
	_ = os.WriteFile(filepath.Join(outDir, "surface.json"), append(surfaceRaw, '\n'), 0o644)
	if openedMenu {
		_ = session.desktop.PressKey(snap.Window, "escape")
	}
	write()
	return result
}

// openSurfaceMenu clicks the root menu bar extra: the only menuitem in the
// surface tree without a name. Named items are user-visible actions (打开
// Graph / 退出 Graph) and are never pressed by a journey, because 退出 Graph
// would stop the instance under test.
func openSurfaceMenu(desktop *appinstance.Desktop, snap appinstance.SurfaceSnapshot) string {
	for _, node := range snap.Nodes {
		if node.Role == "menuitem" && strings.TrimSpace(node.Name) == "" && node.Ref != "" {
			if _, err := desktop.ClickRef(node.Ref); err != nil {
				return err.Error()
			}
			return ""
		}
	}
	return "the surface exposes no unnamed menu item to open"
}
