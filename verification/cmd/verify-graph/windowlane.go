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

// The window lane runs the same journey files as the headless lane, but drives
// the real Graph window through agent-desktop's accessibility API. It exists
// because "the view code would render this" and "a user can press this in the
// real window" are different claims. Every step leaves a JSON accessibility
// dump or a PNG, and the API checks still read the same isolated daemon.

type windowSession struct {
	p        paths
	meta     runMeta
	instance *appinstance.Instance
	desktop  *appinstance.Desktop
	window   appinstance.Window
	launched bool
}

func ensureWindowSession(p paths, meta runMeta, timeout time.Duration) (*windowSession, error) {
	instance, err := windowInstance(p, meta)
	if err != nil {
		return nil, err
	}
	if err := instance.DesktopClient().Available(); err != nil {
		return nil, fmt.Errorf("agent-desktop is not available: %w", err)
	}
	session := &windowSession{p: p, meta: meta, instance: instance, desktop: instance.DesktopClient()}
	if instance.AppPID > 0 && appinstance.ProcessAlive(instance.AppPID) {
		if window, err := instance.Window(""); err == nil && window.Visible {
			_ = instance.DesktopClient().FocusWindow(window.ID)
			session.window = window
			return session, nil
		}
	}
	launched, err := instance.LaunchWindowOnly(timeout)
	if err != nil {
		return nil, fmt.Errorf("cannot open the run's window: %w", err)
	}
	window, err := instance.Window(launched.WindowID)
	if err != nil {
		return nil, fmt.Errorf("the window opened but cannot be resolved: %w", err)
	}
	// A verification window that is not frontmost is captured as whatever app
	// is in front of it. Focus it once here so every PNG is the Graph window.
	_ = instance.DesktopClient().FocusWindow(window.ID)
	session.window = window
	session.launched = true
	return session, nil
}

func (s *windowSession) Close() {
	if s == nil || s.instance == nil {
		return
	}
	s.instance.Stop()
}

func (s *windowSession) refreshWindow() error {
	window, err := s.instance.Window(s.window.ID)
	if err != nil {
		return err
	}
	s.window = window
	return nil
}

func (s *windowSession) snapshot() (appinstance.Snapshot, error) {
	snapshot, err := s.desktop.SnapshotDeep(s.window.ID)
	if err == nil {
		return snapshot, nil
	}
	if refreshErr := s.refreshWindow(); refreshErr != nil {
		return appinstance.Snapshot{}, err
	}
	return s.desktop.SnapshotDeep(s.window.ID)
}

func (s *windowSession) waitText(text string, timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	for {
		snapshot, err := s.snapshot()
		if err == nil && snapshot.Contains(text) {
			return true, nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				return false, err
			}
			return false, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func namesSummary(snapshot appinstance.Snapshot) string {
	names := snapshot.Names()
	if len(names) <= 40 {
		return strings.Join(names, " | ")
	}
	return strings.Join(names[:20], " | ") + fmt.Sprintf(" | …%d more… | ", len(names)-40) +
		strings.Join(names[len(names)-20:], " | ")
}

func dumpAccess(snapshot appinstance.Snapshot) []accessDump {
	dumps := make([]accessDump, 0, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		dumps = append(dumps, accessDump{Name: node.Name, Role: node.Role, Value: node.Value})
	}
	return dumps
}

func findAccess(snapshot appinstance.Snapshot, name, role string) (appinstance.Node, bool) {
	wantedRole := strings.ToLower(strings.TrimSpace(role))
	for _, node := range snapshot.Nodes {
		if node.Name != name {
			continue
		}
		actualRole := strings.ToLower(node.Role)
		if wantedRole == "" || wantedRole == "any" || actualRole == wantedRole {
			return node, true
		}
		if wantedRole == "text" && (actualRole == "textfield" || actualRole == "textbox") {
			return node, true
		}
	}
	return appinstance.Node{}, false
}

func runJourneyWindow(session *windowSession, value journey, outDir string) journeyResult {
	result := journeyResult{OK: true, Lane: "window"}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return journeyResult{OK: false, Lane: "window", Error: err.Error(), ExitCode: 1}
	}
	resultPath := filepath.Join(outDir, "result.json")
	write := func() {
		raw, _ := json.MarshalIndent(result, "", "  ")
		_ = os.WriteFile(resultPath, raw, 0o644)
	}
	snapshot, err := session.snapshot()
	if err != nil {
		result.OK = false
		result.Error = "cannot snapshot the real window: " + err.Error()
		write()
		return result
	}
	fail := func(index int, verb, detail string) journeyResult {
		result.OK = false
		result.Error = fmt.Sprintf("step %d (%s): %s", index+1, verb, detail)
		write()
		return result
	}
	for index, current := range value.Steps {
		outcome := stepOutcome{Index: index + 1, Verb: current.Verb, OK: true}
		timeout := 8 * time.Second
		if current.TimeoutMs > 0 {
			timeout = time.Duration(current.TimeoutMs) * time.Millisecond
		}
		switch current.Verb {
		case "frame":
			snapshot, err = session.snapshot()
			if err != nil {
				return fail(index, current.Verb, "cannot snapshot the window: "+err.Error())
			}
		case "waitText":
			seen, waitErr := session.waitText(current.Text, timeout)
			if !seen {
				detail := fmt.Sprintf("text %q did not appear within %s; the window shows: %s", current.Text, timeout, namesSummary(snapshot))
				if waitErr != nil {
					detail += " (snapshot error: " + waitErr.Error() + ")"
				}
				return fail(index, current.Verb, detail)
			}
			outcome.Detail = "visible: " + current.Text
		case "assertText":
			snapshot, err = session.snapshot()
			if err != nil {
				return fail(index, current.Verb, "cannot snapshot the window: "+err.Error())
			}
			if !snapshot.Contains(current.Text) {
				return fail(index, current.Verb, fmt.Sprintf("expected text %q; the window shows: %s", current.Text, namesSummary(snapshot)))
			}
			outcome.Detail = "visible: " + current.Text
		case "assertNoText":
			snapshot, err = session.snapshot()
			if err != nil {
				return fail(index, current.Verb, "cannot snapshot the window: "+err.Error())
			}
			if snapshot.Contains(current.Text) {
				return fail(index, current.Verb, fmt.Sprintf("unexpected text %q is still visible", current.Text))
			}
		case "click":
			if _, clickErr := session.desktop.ClickByName(session.window, current.Name); clickErr != nil {
				return fail(index, current.Verb, fmt.Sprintf("cannot click %q: %v; the window shows: %s", current.Name, clickErr, namesSummary(snapshot)))
			}
			outcome.Detail = "clicked: " + current.Name
		case "clickIf":
			if !snapshot.Contains(current.Name) {
				outcome.Skipped = true
				outcome.Detail = "skipped: " + current.Name + " is not on screen"
				result.Steps = append(result.Steps, outcome)
				continue
			}
			if _, clickErr := session.desktop.ClickByName(session.window, current.Name); clickErr != nil {
				return fail(index, current.Verb, fmt.Sprintf("cannot click %q: %v; the window shows: %s", current.Name, clickErr, namesSummary(snapshot)))
			}
			outcome.Detail = "clicked: " + current.Name
		case "type":
			if _, typeErr := session.desktop.SetText(session.window, current.Role, current.Name, current.Text); typeErr != nil {
				return fail(index, current.Verb, fmt.Sprintf("cannot type into %q: %v; the window shows: %s", current.Name, typeErr, namesSummary(snapshot)))
			}
			outcome.Detail = fmt.Sprintf("typed %q into %s", current.Text, current.Name)
		case "key":
			if keyErr := session.desktop.PressKey(session.window, current.Key); keyErr != nil {
				return fail(index, current.Verb, fmt.Sprintf("cannot press %q: %v", current.Key, keyErr))
			}
			outcome.Detail = "pressed " + current.Key
		case "assertAccess":
			snapshot, err = session.snapshot()
			if err != nil {
				return fail(index, current.Verb, "cannot snapshot the window: "+err.Error())
			}
			node, found := findAccess(snapshot, current.Name, current.Role)
			if !found {
				return fail(index, current.Verb, fmt.Sprintf("%q is not exposed with role %q; the window exposes: %s", current.Name, current.Role, namesSummary(snapshot)))
			}
			if current.Value != "" && !strings.Contains(node.Value, current.Value) {
				return fail(index, current.Verb, fmt.Sprintf("%q reads %q to assistive tech, which does not contain %q", current.Name, node.Value, current.Value))
			}
			result.Access = append(result.Access, accessDump{Name: node.Name, Role: node.Role, Value: node.Value})
			outcome.Detail = "exposed as " + firstNonEmpty(node.Role, current.Role)
			if current.Value != "" {
				outcome.Detail = fmt.Sprintf("exposed as %s with value %q", firstNonEmpty(node.Role, current.Role), node.Value)
			}
		case "screenshot":
			name := current.Path
			if name == "" {
				name = fmt.Sprintf("frame-%02d.png", index+1)
			}
			path := filepath.Join(outDir, name)
			_ = session.desktop.FocusWindow(session.window.ID)
			_ = session.refreshWindow()
			if shotErr := session.desktop.ScreenshotRect(session.window, path); shotErr != nil {
				// A window the window manager moved off every display cannot be
				// captured by region. Bring it back once, then fail with the
				// bounds so the evidence says why instead of writing a black PNG.
				_ = session.desktop.FocusWindow(session.window.ID)
				_ = session.refreshWindow()
				if retryErr := session.desktop.ScreenshotRect(session.window, path); retryErr != nil {
					return fail(index, current.Verb, fmt.Sprintf("cannot capture the window: %v; bounds are %.0fx%.0f at %.0f,%.0f (a window off every display cannot be captured by region)",
						retryErr, session.window.Bounds.Width, session.window.Bounds.Height, session.window.Bounds.X, session.window.Bounds.Y))
				}
			}
			result.Frames = append(result.Frames, path)
			outcome.Detail = path
		default:
			return fail(index, current.Verb, fmt.Sprintf("the window lane does not implement %q; use the headless lane for this step or add it to windowlane.go", current.Verb))
		}
		result.Steps = append(result.Steps, outcome)
	}
	snapshot, snapshotErr := session.snapshot()
	if snapshotErr == nil {
		result.Texts = snapshot.Names()
		if len(result.Access) == 0 {
			result.Access = dumpAccess(snapshot)
		}
	}
	write()
	return result
}

// stagedJourney is one journey whose API fixtures have run. All fixtures for a
// mode run before that mode's window opens: the app loads its conversation list
// once, so a project thread created after the window appeared would never be
// visible to the window lane.
type stagedJourney struct {
	value      journey
	outDir     string
	assertions []assertion
	seeded     bool
}

func verifyWindowLane(p paths, flags flags, references []string) int {
	started := time.Now()
	pinned := flags.value("run", "")
	if flags.has("dry-run") {
		return okEnvelope("verify", "window", map[string]any{
			"dryRun": true, "journeys": references, "runId": pinned,
			"note": "the window lane opens the real Graph window once per instance mode and reuses it",
		}).print()
	}
	values := []journey{}
	summaries := []map[string]any{}
	failures := []string{}
	failureViews := []map[string]any{}
	for _, reference := range references {
		value, resolveErr := resolveJourney(p, reference)
		if resolveErr != nil {
			failures = append(failures, resolveErr.Error())
			summaries = append(summaries, map[string]any{"journey": reference, "ok": false, "error": resolveErr.Error()})
			continue
		}
		values = append(values, value)
	}
	order := []string{}
	groups := map[string][]journey{}
	for _, value := range values {
		mode := value.mode()
		if _, seen := groups[mode]; !seen {
			order = append(order, mode)
		}
		groups[mode] = append(groups[mode], value)
	}
	timeout := time.Duration(flags.number("timeout", 120)) * time.Second
	artifacts := []artifact{}
	runIDs := []string{}
	runViews := []map[string]any{}
	firstWindow := ""
	firstPID := 0
	for _, mode := range order {
		meta, err := ensureRunForMode(p, pinned, mode, false)
		if err != nil {
			return failEnvelope("verify", "window", codeDaemonDown, err.Error(), "run: verify-graph launch --mode "+mode).print()
		}
		runIDs = append(runIDs, meta.RunID)
		stage := make([]stagedJourney, 0, len(groups[mode]))
		for _, value := range groups[mode] {
			outDir := filepath.Join(p.EvidenceRoot, meta.RunID, value.Feature)
			assertions, seeded := prepareJourney(p, meta, value, outDir)
			stage = append(stage, stagedJourney{value: value, outDir: outDir, assertions: assertions, seeded: seeded})
		}
		session, err := ensureWindowSession(p, meta, timeout)
		if err != nil {
			session.Close()
			return failEnvelope("verify", "window", codeDaemonDown,
				"cannot drive the real window for "+mode+": "+err.Error(),
				"run: verify-graph doctor; if accessibility was reset, grant it again, then retry").print()
		}
		if firstWindow == "" {
			firstWindow = session.window.ID
			firstPID = session.instance.AppPID
		}
		groupPassed := 0
		for _, job := range stage {
			value, outDir, assertions, seeded := job.value, job.outDir, job.assertions, job.seeded
			result := journeyResult{OK: true}
			if seeded {
				if value.Surface != "" {
					result = runJourneySurface(p, meta, value, outDir, session)
				} else {
					result = runJourneyWindow(session, value, outDir)
				}
			} else {
				result.OK = false
				result.Error = "the seeded conversation failed before the window could be driven"
			}
			assertions = append(assertions, runChecks(p, meta, value, outDir)...)
			_, written := writeEvidence(p, meta, value, result, assertions, outDir, started)
			artifacts = append(artifacts, written...)
			ok := result.OK
			for _, item := range assertions {
				if !item.OK {
					ok = false
				}
			}
			summary := map[string]any{
				"journey": value.ID, "feature": value.Feature, "ok": ok, "lane": "window", "instance": mode,
				"steps": len(result.Steps), "checks": len(assertions),
				"error": result.Error, "evidence": outDir,
			}
			if ok {
				groupPassed++
			} else {
				failure := describeFailure(meta, value, result, assertions, outDir)
				failure["lane"] = "window"
				summary["failure"] = failure
				failureViews = append(failureViews, failure)
				failures = append(failures, failure["message"].(string))
			}
			summaries = append(summaries, summary)
		}
		runViews = append(runViews, map[string]any{
			"runId": meta.RunID, "mode": mode, "journeys": len(groups[mode]),
			"passed": groupPassed, "windowId": session.window.ID, "appPid": session.instance.AppPID,
			"evidence": filepath.Join(p.EvidenceRoot, meta.RunID),
		})
		session.Close()
	}
	primary := ""
	if len(runIDs) > 0 {
		primary = runIDs[0]
	}
	envelopeResult := okEnvelope("verify", "window", map[string]any{
		"journeys": summaries, "passed": countTrue(summaries), "failed": len(summaries) - countTrue(summaries),
		"evidenceRoot": filepath.Join(p.EvidenceRoot, primary), "durationMs": time.Since(started).Milliseconds(),
		"windowId": firstWindow, "appPid": firstPID, "runs": runViews, "failures": failureViews,
	})
	envelopeResult.RunID = primary
	for _, item := range artifacts {
		envelopeResult.add(item)
	}
	if len(failures) > 0 {
		envelopeResult.OK = false
		hint := "read data.failures: each entry names the journey, expected, actual, evidence and the exact nextCommand"
		if next, ok := failureViews[0]["nextCommand"].(string); ok && next != "" {
			hint = "rerun one path with: " + next + " --lane window; read data.failures for expected/actual/evidence"
		}
		envelopeResult.Error = &cliError{
			Code:    codeScenarioFailed,
			Message: strings.Join(failures, "; "),
			Hint:    hint,
		}
	}
	code := envelopeResult.print()
	if !flags.has("keep") && pinned == "" {
		for _, id := range runIDs {
			stopRunQuietly(p, id)
		}
	}
	return code
}
