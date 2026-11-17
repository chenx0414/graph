package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func sha256File(path string) (string, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), info.Size(), nil
}

func fileArtifact(kind, path, note string) artifact {
	sum, size, err := sha256File(path)
	if err != nil {
		return artifact{Kind: kind, Path: path, Note: note}
	}
	return artifact{Kind: kind, Path: path, SHA256: sum, Bytes: size, Note: note}
}

func doctorCommand(p paths, args []string) int {
	checks := []map[string]any{}
	add := func(id string, ok bool, detail, hint string) {
		checks = append(checks, map[string]any{"id": id, "ok": ok, "detail": detail, "hint": hint})
	}
	binary := filepath.Join(p.RunRoot, "bin", "graphd")
	if info, err := os.Stat(binary); err == nil {
		add("daemon-binary", info.Mode()&0o111 != 0, binary, "run: verify-graph build --component daemon")
	} else {
		add("daemon-binary", false, binary+" missing", "run: verify-graph build --component daemon")
	}
	appBundle := filepath.Join(p.Repo, "dist", "app", "mac-arm64", "Graph.app")
	if info, err := os.Stat(appBundle); err == nil && info.IsDir() {
		add("app-bundle", true, appBundle, "")
	} else {
		add("app-bundle", false, appBundle+" missing", "run: go -C backend run ./cmd/graphbuild app")
	}
	if _, err := os.Stat(filepath.Join(p.Verification, "scenarios")); err == nil {
		add("scenarios", true, scenarioDir(p), "")
	} else {
		add("scenarios", false, scenarioDir(p)+" missing", "restore verification/scenarios")
	}
	runRoot := p.RunRoot
	if err := os.MkdirAll(runRoot, 0o755); err == nil {
		probe := filepath.Join(runRoot, ".doctor-probe")
		writeErr := os.WriteFile(probe, []byte("ok"), 0o644)
		_ = os.Remove(probe)
		add("run-root-writable", writeErr == nil, runRoot, "check permissions on verification/.run")
	} else {
		add("run-root-writable", false, err.Error(), "check permissions on verification/.run")
	}
	desktop := agentDesktopBinary()
	if desktop == "" {
		add("agent-desktop", false, "binary not found", "the app ships it under ~/Library/Application Support/Graph/capabilities/agent-desktop")
	} else {
		output, err := exec.Command(desktop, "permissions").Output()
		ok := err == nil && strings.Contains(string(output), `"accessibility":{"state":"granted"}`)
		add("agent-desktop", ok, strings.TrimSpace(string(output)), "run the agent-desktop permissions check and grant accessibility")
	}
	userState := userGraphStateDir()
	if console, ok := readConsole(userState); ok {
		status, _ := newAPIClient(console.URL, readToken(userState)).getJSON("/api/health", nil)
		add("user-instance", status == 200, fmt.Sprintf("pid %d at %s", console.PID, console.URL), "")
	} else {
		add("user-instance", true, "no user daemon console.json (nothing to protect)", "")
	}
	runs, _ := listRuns(p)
	live := map[int]bool{}
	for _, run := range runs {
		if runAlive(run) {
			live[run.Daemon.PID] = true
		}
	}
	orphans := []daemonProcess{}
	for _, process := range scanDaemons(p) {
		if !live[process.PID] {
			orphans = append(orphans, process)
		}
	}
	add("orphans", true, fmt.Sprintf("%d daemon(s) under verification/.run with no live run record (reported, never killed)", len(orphans)), "verify-graph cleanup --run <id> only stops recorded runs")
	allOK := true
	for _, check := range checks {
		if !check["ok"].(bool) {
			allOK = false
		}
	}
	result := okEnvelope("doctor", "", map[string]any{"checks": checks, "orphans": orphans, "runs": runs})
	if !allOK {
		result.OK = false
		result.Error = &cliError{Code: "doctor-failed", Message: "one or more doctor checks failed", Hint: "fix the first failing check's hint, then rerun verify-graph doctor"}
	}
	code := result.print()
	if !allOK {
		return 3
	}
	return code
}

func agentDesktopBinary() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	candidates := []string{
		filepath.Join(home, "Library", "Application Support", "Graph", "capabilities", "agent-desktop", "node_modules", "agent-desktop", "bin", "agent-desktop-darwin-arm64"),
		filepath.Join(home, "Library", "Application Support", "Graph", "capabilities", "agent-desktop", "node_modules", "agent-desktop", "bin", "agent-desktop-darwin-x64"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	return ""
}

func userGraphStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Library", "Application Support", "Graph", "state")
}

func buildCommand(p paths, args []string) int {
	flags := parseFlags(args)
	component := flags.value("component", "daemon")
	if component == "all" || component == "daemon" {
		if flags.has("dry-run") {
			return okEnvelope("build", "", map[string]any{"dryRun": true, "component": "daemon", "binary": filepath.Join(p.RunRoot, "bin", "graphd")}).print()
		}
		binary, err := ensureDaemonBinary(p)
		if err != nil {
			return failEnvelope("build", "", codeBuildFailed, err.Error(), "run: go -C backend build ./cmd/graphd").print()
		}
		result := okEnvelope("build", "", map[string]any{"component": "daemon", "binary": binary})
		result.add(fileArtifact("binary", binary, "graphd built for isolated runs"))
		return result.print()
	}
	if component == "app" {
		bundle := filepath.Join(p.Repo, "dist", "app", "mac-arm64", "Graph.app")
		if _, err := os.Stat(bundle); err != nil {
			return failEnvelope("build", "", codeBuildFailed, bundle+" is missing",
				"run: go -C backend run ./cmd/graphbuild app").print()
		}
		return okEnvelope("build", "", map[string]any{"component": "app", "bundle": bundle, "note": "the app bundle is built by the repository toolchain; verification only reads it"}).print()
	}
	return failEnvelope("build", "", codeUsage, "unknown component "+component, "use --component daemon|app|all").print()
}

func launchCommand(p paths, args []string) int {
	flags := parseFlags(args)
	options := launchOptions{
		RunID:   flags.value("run", ""),
		Mode:    flags.value("mode", "view"),
		Timeout: time.Duration(flags.number("timeout", 20)) * time.Second,
		DryRun:  flags.has("dry-run"),
		Seed:    flags.has("seed"),
	}
	result, err := launch(p, options)
	if err != nil {
		return failEnvelope("launch", "api", codeDaemonDown, err.Error(), "run: verify-graph doctor").print()
	}
	return result.print()
}

func statusCommand(p paths, args []string) int {
	runs, err := listRuns(p)
	if err != nil {
		return failEnvelope("status", "", codeUsage, err.Error(), "check verification/.run").print()
	}
	now := time.Now()
	type runView struct {
		RunID     string `json:"runId"`
		Alive     bool   `json:"alive"`
		PID       int    `json:"pid"`
		URL       string `json:"url,omitempty"`
		Mode      string `json:"mode,omitempty"`
		CreatedAt string `json:"createdAt"`
		ExpiresAt string `json:"expiresAt,omitempty"`
		Expired   bool   `json:"expired"`
		StateDir  string `json:"stateDir"`
	}
	views := []runView{}
	live := map[int]bool{}
	for _, run := range runs {
		alive := runAlive(run)
		if alive {
			live[run.Daemon.PID] = true
		}
		expired := false
		if run.ExpiresAt != "" {
			if parsed, err := time.Parse(time.RFC3339, run.ExpiresAt); err == nil && now.After(parsed) {
				expired = true
			}
		}
		views = append(views, runView{RunID: run.RunID, Alive: alive, PID: run.Daemon.PID, URL: run.Daemon.URL,
			Mode: run.Daemon.Mode, CreatedAt: run.CreatedAt, ExpiresAt: run.ExpiresAt, Expired: expired, StateDir: run.StateDir})
	}
	orphans := []daemonProcess{}
	for _, process := range scanDaemons(p) {
		if !live[process.PID] {
			orphans = append(orphans, process)
		}
	}
	result := okEnvelope("status", "", map[string]any{"runs": views, "orphans": orphans})
	if len(orphans) > 0 {
		result.warn("%d orphan daemon(s) under verification/.run; they are reported, not killed", len(orphans))
	}
	return result.print()
}

func apiCommand(p paths, args []string) int {
	flags := parseFlags(args)
	if len(flags.rest) == 0 {
		return failEnvelope("api", "api", codeUsage, "a path is required", "verify-graph api GET /api/health --run <id>").print()
	}
	method := "GET"
	path := flags.rest[0]
	if len(flags.rest) > 1 {
		method = strings.ToUpper(flags.rest[0])
		path = flags.rest[1]
	}
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope("api", "api", codeNoRun, err.Error(), "run: verify-graph launch").print()
	}
	if !runAlive(meta) {
		return failEnvelope("api", "api", codeDaemonDown, "run "+meta.RunID+" is not alive", "run: verify-graph launch --run "+meta.RunID).print()
	}
	var body any
	if raw := flags.value("body", ""); raw != "" {
		if err := json.Unmarshal([]byte(raw), &body); err != nil {
			return failEnvelope("api", "api", codeUsage, "invalid --body JSON: "+err.Error(), `pass JSON, e.g. --body '{"projectId":"verify"}'`).print()
		}
	}
	client := newAPIClient(meta.Daemon.URL, readToken(meta.StateDir))
	status, payload, err := client.do(method, path, body)
	if err != nil {
		return failEnvelope("api", "api", codeDaemonDown, err.Error(), "run: verify-graph doctor").print()
	}
	var parsed any
	if json.Unmarshal(payload, &parsed) != nil {
		parsed = string(payload)
	}
	result := okEnvelope("api", "api", map[string]any{"status": status, "body": parsed, "url": meta.Daemon.URL + path})
	result.RunID = meta.RunID
	if status == 401 {
		result.OK = false
		result.Error = &cliError{Code: codeUnauthorized, Message: "the daemon rejected the session cookie", Hint: "the run's session-token changed; relaunch or verify-graph doctor"}
	}
	return result.print()
}

func uiCommand(p paths, args []string) int {
	flags := parseFlags(args)
	if len(flags.rest) == 0 {
		return failEnvelope("ui", "", codeUsage, "a ui verb is required", "verify-graph ui render <journey> --run <id> | verify-graph ui snapshot --run <id>").print()
	}
	verb := flags.rest[0]
	switch verb {
	case "render":
		reference := ""
		if len(flags.rest) > 1 {
			reference = flags.rest[1]
		}
		return renderCommand(p, flags, reference)
	case "snapshot":
		return snapshotCommand(p, flags)
	case "window":
		return uiWindowCommand(p, flags)
	case "motion":
		return motionCommand(p, parseFlags(args[1:]))
	default:
		return failEnvelope("ui", "", codeUsage, "unknown ui verb "+verb, "use: ui render | ui snapshot | ui window open|click|shot|close | ui motion open|tree|press|shot|close").print()
	}
}

func renderCommand(p paths, flags flags, reference string) int {
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope("ui.render", "headless", codeNoRun, err.Error(), "run: verify-graph launch").print()
	}
	if !runAlive(meta) {
		return failEnvelope("ui.render", "headless", codeDaemonDown, "run "+meta.RunID+" is not alive", "run: verify-graph launch --run "+meta.RunID).print()
	}
	value, err := resolveJourney(p, reference)
	if err != nil {
		return failEnvelope("ui.render", "headless", codeJourneyFileBroken, err.Error(), "list journeys with: ls verification/scenarios").print()
	}
	outDir := flags.value("out", filepath.Join(p.EvidenceRoot, meta.RunID, "ui-render", value.ID))
	result := runJourneyHeadless(p, meta, value, outDir)
	envelopeResult := okEnvelope("ui.render", "headless", map[string]any{
		"journey": value.ID, "feature": value.Feature, "steps": result.Steps, "texts": tailTexts(result.Texts, 60),
		"error": result.Error, "output": result.Output,
	})
	envelopeResult.RunID = meta.RunID
	envelopeResult.OK = result.OK
	if !result.OK {
		envelopeResult.Error = &cliError{Code: codeScenarioFailed, Message: firstNonEmpty(result.Error, "the headless journey failed"), Hint: "inspect data.steps, then rerun with --out to keep the artifacts"}
	}
	for _, frame := range result.Frames {
		envelopeResult.add(fileArtifact("png", frame, "headless render frame"))
	}
	if resultPath := filepath.Join(outDir, "result.json"); fileExists(resultPath) {
		envelopeResult.add(fileArtifact("json", resultPath, "headless journey result"))
	}
	return envelopeResult.print()
}

func snapshotCommand(p paths, flags flags) int {
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope("ui.snapshot", "window", codeNoRun, err.Error(), "run: verify-graph launch --mode execute then reopen a window").print()
	}
	binary := agentDesktopBinary()
	if binary == "" {
		return failEnvelope("ui.snapshot", "window", "ax-denied", "agent-desktop binary not found", "install Graph's agent-desktop capability").print()
	}
	app := flags.value("app", "Graph")
	output, err := exec.Command(binary, "snapshot", "--app", app, "--interactive-only", "--skeleton").Output()
	if err != nil {
		return failEnvelope("ui.snapshot", "window", "ax-denied", "snapshot failed: "+err.Error(), "check: agent-desktop permissions").print()
	}
	outDir := filepath.Join(p.EvidenceRoot, meta.RunID, "ui-snapshot")
	_ = os.MkdirAll(outDir, 0o755)
	path := filepath.Join(outDir, "snapshot.json")
	if err := os.WriteFile(path, output, 0o644); err != nil {
		return failEnvelope("ui.snapshot", "window", codeUsage, err.Error(), "check verification/evidence permissions").print()
	}
	var parsed map[string]any
	_ = json.Unmarshal(output, &parsed)
	result := okEnvelope("ui.snapshot", "window", map[string]any{"app": app, "snapshot": parsed})
	result.RunID = meta.RunID
	result.add(fileArtifact("json", path, "accessibility snapshot (interactive only)"))
	return result.print()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func tailTexts(texts []string, limit int) []string {
	if len(texts) <= limit {
		return texts
	}
	return texts[len(texts)-limit:]
}
