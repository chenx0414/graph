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

// The step-at-a-time verbs (`ui text|expect|click|screenshot`) drive the run's
// own real window through the accessibility tree. They exist so a cold agent
// can investigate one control before writing a journey, using the same window
// the window lane uses (same AppPID, same isolated daemon). A journey is the
// reproducible proof; these verbs are how you find the exact label a journey
// must assert.
func uiManualCommand(p paths, flags flags, verb string) int {
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope("ui."+verb, "window", codeNoRun, "a live run is required: "+err.Error(),
			"run: verify-graph launch  (then: verify-graph ui text --run <id>)").print()
	}
	if !runAlive(meta) {
		return failEnvelope("ui."+verb, "window", codeDaemonDown, "run "+meta.RunID+" is not alive",
			"run: verify-graph launch --run "+meta.RunID).print()
	}
	timeout := time.Duration(flags.number("timeout", 90)) * time.Second
	session, err := ensureWindowSession(p, meta, timeout)
	if err != nil {
		return failEnvelope("ui."+verb, "window", codeDaemonDown, err.Error(),
			"run: verify-graph doctor; the window lane needs agent-desktop accessibility and a visible window").print()
	}
	outDir := flags.value("out-dir", filepath.Join(p.EvidenceRoot, meta.RunID, "ui-"+verb))
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return failEnvelope("ui."+verb, "window", codeUsage, err.Error(), "check permissions on verification/evidence").print()
	}
	switch verb {
	case "text":
		return uiManualText(p, meta, session, outDir, flags)
	case "expect":
		return uiManualExpect(p, meta, session, outDir, flags)
	case "click":
		return uiManualClick(p, meta, session, outDir, flags)
	case "screenshot":
		return uiManualScreenshot(p, meta, session, outDir, flags)
	default:
		return failEnvelope("ui."+verb, "window", codeUsage, "unknown ui verb "+verb,
			"use: ui text|expect|click|screenshot").print()
	}
}

func saveWindowSnapshot(session *windowSession, path string) (appinstance.Snapshot, artifact) {
	snapshot, err := session.snapshot()
	if err != nil {
		return appinstance.Snapshot{}, artifact{}
	}
	raw, _ := json.MarshalIndent(map[string]any{
		"windowId": session.window.ID,
		"title":    session.window.Title,
		"nodes":    snapshot.Nodes,
	}, "", "  ")
	if writeErr := os.WriteFile(path, raw, 0o644); writeErr != nil {
		return snapshot, artifact{}
	}
	return snapshot, fileArtifact("json", path, "accessibility snapshot")
}

func uiManualText(p paths, meta runMeta, session *windowSession, outDir string, flags flags) int {
	path := filepath.Join(outDir, "ax.json")
	snapshot, art := saveWindowSnapshot(session, path)
	if snapshot.Nodes == nil {
		return failEnvelope("ui.text", "window", codeScenarioFailed, "cannot read the accessibility tree",
			"run: verify-graph doctor; the window may be busy, retry with --timeout 120").print()
	}
	names := snapshot.Names()
	limit := 200
	if len(names) < limit {
		limit = len(names)
	}
	result := okEnvelope("ui.text", "window", map[string]any{
		"windowId": session.window.ID, "elements": len(snapshot.Nodes), "names": names[:limit],
	})
	result.RunID = meta.RunID
	result.add(art)
	return result.print()
}

func uiManualExpect(p paths, meta runMeta, session *windowSession, outDir string, flags flags) int {
	name := flags.value("name", "")
	if name == "" && len(flags.rest) > 1 {
		name = flags.rest[1]
	}
	if name == "" {
		return failEnvelope("ui.expect", "window", codeUsage, "a --name is required",
			"list labels first: verify-graph ui text --run "+meta.RunID).print()
	}
	role := flags.value("role", "")
	value := flags.value("value", "")
	slug := motionSlug(name)
	path := filepath.Join(outDir, "expect-"+slug+".json")
	snapshot, art := saveWindowSnapshot(session, path)
	node, found := findAccess(snapshot, name, role)
	data := map[string]any{
		"windowId": session.window.ID, "name": name, "role": role,
		"expected": "an element named " + name + " is exposed to assistive tech",
	}
	result := okEnvelope("ui.expect", "window", data)
	result.RunID = meta.RunID
	if art.Path != "" {
		result.add(art)
	}
	if png := filepath.Join(outDir, "expect-"+slug+".png"); session.desktop.ScreenshotRect(session.window, png) == nil {
		result.add(fileArtifact("png", png, "the window at the moment of the expectation"))
	}
	if !found {
		result.OK = false
		data["actual"] = "not exposed; the window shows: " + motionNodesText(snapshot.Nodes)
		result.Error = &cliError{Code: codeLabelNotFound,
			Message: fmt.Sprintf("%q is not in the accessibility tree with role %q", name, firstNonEmpty(role, "any")),
			Hint:    "run: verify-graph ui text --run " + meta.RunID + " to list the exact labels, then retry"}
		return result.print()
	}
	if value != "" && !strings.Contains(node.Value, value) {
		result.OK = false
		data["actual"] = fmt.Sprintf("%s reads %q", name, node.Value)
		result.Error = &cliError{Code: codeScenarioFailed,
			Message: fmt.Sprintf("%q reads %q to assistive tech, which does not contain %q", name, node.Value, value),
			Hint:    "a text field keeps its content as an AX value; assert the value, not visible text"}
		return result.print()
	}
	data["actual"] = map[string]any{"name": node.Name, "role": node.Role, "value": node.Value}
	return result.print()
}

func uiManualClick(p paths, meta runMeta, session *windowSession, outDir string, flags flags) int {
	name := flags.value("name", "")
	if name == "" && len(flags.rest) > 1 {
		name = flags.rest[1]
	}
	if name == "" {
		return failEnvelope("ui.click", "window", codeUsage, "a --name is required",
			"run: verify-graph ui click --run "+meta.RunID+" --name 洞察 --expect 洞察概览").print()
	}
	slug := motionSlug(name)
	beforePath := filepath.Join(outDir, "before-"+slug+".json")
	before, beforeArt := saveWindowSnapshot(session, beforePath)
	data := map[string]any{
		"windowId": session.window.ID, "target": name,
		"expected": "pressing " + name + " changes the window",
	}
	result := okEnvelope("ui.click", "window", data)
	result.RunID = meta.RunID
	if beforeArt.Path != "" {
		result.add(beforeArt)
	}
	if _, err := session.desktop.ClickByName(session.window, name); err != nil {
		result.OK = false
		data["actual"] = "cannot press it: " + err.Error() + "; the window shows: " + motionNodesText(before.Nodes)
		result.Error = &cliError{Code: codeLabelNotFound, Message: err.Error(),
			Hint: "run: verify-graph ui text --run " + meta.RunID + " to list the exact labels"}
		return result.print()
	}
	expect := flags.value("expect", "")
	if expect != "" {
		deadline := time.Duration(flags.number("timeout", 40)) * time.Second
		seen, waitErr := session.waitText(expect, deadline)
		if !seen {
			message := fmt.Sprintf("after pressing %q, %q did not appear within %s", name, expect, deadline)
			if waitErr != nil {
				message += " (snapshot error: " + waitErr.Error() + ")"
			}
			result.OK = false
			data["actual"] = message
			result.Error = &cliError{Code: codeScenarioFailed, Message: message,
				Hint: "run: verify-graph ui text --run " + meta.RunID + " to see what the window shows now"}
			return result.print()
		}
		data["expect"] = expect
	}
	afterPath := filepath.Join(outDir, "after-"+slug+".json")
	after, afterArt := saveWindowSnapshot(session, afterPath)
	if afterArt.Path != "" {
		result.add(afterArt)
	}
	added, removed := diffNames(before, after)
	data["actual"] = map[string]any{"added": added, "removed": removed}
	if png := filepath.Join(outDir, "after-"+slug+".png"); session.desktop.ScreenshotRect(session.window, png) == nil {
		result.add(fileArtifact("png", png, "the window after pressing "+name))
	}
	return result.print()
}

func uiManualScreenshot(p paths, meta runMeta, session *windowSession, outDir string, flags flags) int {
	out := flags.value("out", filepath.Join(outDir, "window.png"))
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return failEnvelope("ui.screenshot", "window", codeUsage, err.Error(), "check the --out path").print()
	}
	_ = session.refreshWindow()
	if err := session.desktop.ScreenshotRect(session.window, out); err != nil {
		return failEnvelope("ui.screenshot", "window", codeScenarioFailed, err.Error(),
			"the window must be visible; /usr/sbin/screencapture -x -R<x,y,w,h> only works on a visible window").print()
	}
	result := okEnvelope("ui.screenshot", "window", map[string]any{
		"windowId": session.window.ID, "bounds": session.window.Bounds, "path": out,
	})
	result.RunID = meta.RunID
	result.add(fileArtifact("png", out, "the isolated window as the user sees it"))
	return result.print()
}

func motionNodesText(nodes []appinstance.Node) string {
	names := []string{}
	for _, node := range nodes {
		if node.Name == "" {
			continue
		}
		names = append(names, node.Name)
		if len(names) == 30 {
			break
		}
	}
	return strings.Join(names, " | ")
}

func diffNames(before, after appinstance.Snapshot) ([]string, []string) {
	beforeNames := map[string]int{}
	for _, node := range before.Nodes {
		beforeNames[node.Name]++
	}
	afterNames := map[string]int{}
	for _, node := range after.Nodes {
		afterNames[node.Name]++
	}
	added, removed := []string{}, []string{}
	for name, count := range afterNames {
		if name != "" && count > beforeNames[name] {
			added = append(added, name)
		}
	}
	for name, count := range beforeNames {
		if name != "" && count > afterNames[name] {
			removed = append(removed, name)
		}
	}
	return added, removed
}
