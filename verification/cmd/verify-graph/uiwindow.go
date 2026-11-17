package main

import (
	"os"
	"path/filepath"
	"time"

	"graph/verification/internal/appinstance"
)

func windowInstance(p paths, meta runMeta) (*appinstance.Instance, error) {
	appBinary := filepath.Join(p.Repo, "dist", "app", "mac-arm64", "Graph.app", "Contents", "MacOS", "Graph")
	if override := os.Getenv("VERIFY_GRAPH_APP_BINARY"); override != "" {
		appBinary = override
	}
	return appinstance.New(appinstance.Options{
		Repo:         p.Repo,
		Root:         filepath.Join(p.RunRoot, meta.RunID),
		Mode:         firstNonEmpty(meta.Daemon.Mode, "view"),
		AppBinary:    appBinary,
		StateDirPath: meta.StateDir,
		HomeDirPath:  meta.Home,
		TmpDirPath:   meta.Tmp,
		ConfigFile:   meta.Config,
	})
}

func uiWindowCommand(p paths, flags flags) int {
	verb := ""
	if len(flags.rest) > 1 {
		verb = flags.rest[1]
	}
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope("ui.window", "window", codeNoRun, "a live run is required: "+err.Error(),
			"run: verify-graph launch  (then: verify-graph ui window open --run <id>)").print()
	}
	instance, err := windowInstance(p, meta)
	if err != nil {
		return failEnvelope("ui.window", "window", codeUsage, err.Error(), "check the run's paths").print()
	}
	outDir := flags.value("out", filepath.Join(p.EvidenceRoot, meta.RunID, "ui-window"))
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return failEnvelope("ui.window", "window", codeUsage, err.Error(), "check permissions on verification/evidence").print()
	}
	instance.Options.EvidenceDirPath = outDir
	switch verb {
	case "open":
		return uiWindowOpen(p, flags, meta, instance, outDir)
	case "click":
		return uiWindowClick(meta, instance, flags)
	case "shot":
		return uiWindowShot(meta, instance, flags)
	case "close":
		lines := instance.Stop()
		result := okEnvelope("ui.window", "window", map[string]any{"closed": lines})
		result.RunID = meta.RunID
		return result.print()
	default:
		return failEnvelope("ui.window", "window", codeUsage, "unknown ui window verb "+verb,
			"use: ui window open|click|shot|close").print()
	}
}

func uiWindowOpen(p paths, flags flags, meta runMeta, instance *appinstance.Instance, outDir string) int {
	if flags.has("dry-run") {
		result := okEnvelope("ui.window", "window", map[string]any{"dryRun": true, "app": instance.AppPath(), "runId": meta.RunID})
		result.RunID = meta.RunID
		return result.print()
	}
	if err := instance.DesktopClient().Available(); err != nil {
		return failEnvelope("ui.window", "window", codeDaemonDown, err.Error(),
			"the agent-desktop binary must exist; see coordination/STATUS-a542aae9.md").print()
	}
	timeout := time.Duration(flags.number("timeout", 90)) * time.Second
	launched, err := instance.LaunchWindowOnly(timeout)
	if err != nil {
		return failEnvelope("ui.window", "window", codeDaemonDown, err.Error(),
			"read "+instance.AppLog()+"; the window must attach to the run's daemon").print()
	}
	result := okEnvelope("ui.window", "window", map[string]any{
		"appPid": launched.AppPID, "windowId": launched.WindowID, "url": launched.URL, "mode": launched.Mode,
	})
	result.RunID = meta.RunID
	if png := filepath.Join(outDir, "window.png"); instance.Screenshot(launched.WindowID, png) == nil {
		result.add(fileArtifact("screenshot", png, "the isolated window before any interaction"))
	}
	return result.print()
}

func uiWindowClick(meta runMeta, instance *appinstance.Instance, flags flags) int {
	name := flags.value("name", "")
	if name == "" && len(flags.rest) > 2 {
		name = flags.rest[2]
	}
	if name == "" {
		return failEnvelope("ui.window", "window", codeUsage, "a --name is required",
			"run: verify-graph ui window click --run <id> --name 洞察 --expect 洞察概览").print()
	}
	windowID := flags.value("window", "")
	window, err := instance.Window(windowID)
	if err != nil {
		return failEnvelope("ui.window", "window", codeNoRun, err.Error(),
			"run: verify-graph ui window open --run "+meta.RunID).print()
	}
	expect := flags.value("expect", "")
	timeout := time.Duration(flags.number("timeout", 40)) * time.Second
	step, artifacts, err := instance.ClickAndProve(window, name, expect, timeout)
	if err != nil {
		return failEnvelope("ui.window", "window", codeLabelNotFound, err.Error(), step.Hint).print()
	}
	data := map[string]any{"windowId": window.ID, "target": name, "expected": step.Expected, "actual": step.Actual}
	result := okEnvelope("ui.window", "window", data)
	result.RunID = meta.RunID
	result.OK = step.OK
	for _, artifact := range artifacts {
		result.add(fileArtifact(artifact.Kind, artifact.Path, "drive evidence for "+name))
	}
	if !step.OK {
		result.Error = &cliError{Code: codeScenarioFailed, Message: step.Actual, Hint: step.Hint}
	}
	return result.print()
}

func uiWindowShot(meta runMeta, instance *appinstance.Instance, flags flags) int {
	window, err := instance.Window(flags.value("window", ""))
	if err != nil {
		return failEnvelope("ui.window", "window", codeNoRun, err.Error(),
			"run: verify-graph ui window open --run "+meta.RunID).print()
	}
	out := flags.value("out", filepath.Join(instance.EvidenceDir(), "window.png"))
	instance.Options.EvidenceDirPath = filepath.Dir(out)
	if err := instance.Screenshot(window.ID, out); err != nil {
		return failEnvelope("ui.window", "window", codeLabelNotFound, err.Error(),
			"the window must be visible; /usr/sbin/screencapture -x -R<x,y,w,h> only works on a visible window").print()
	}
	result := okEnvelope("ui.window", "window", map[string]any{"windowId": window.ID, "bounds": window.Bounds})
	result.RunID = meta.RunID
	result.add(fileArtifact("screenshot", out, "the isolated window as the user sees it"))
	return result.print()
}
