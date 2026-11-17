package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func scenarioCommand(p paths, args []string) int {
	flags := parseFlags(args)
	if len(flags.rest) < 2 || flags.rest[0] != "run" {
		return failEnvelope("scenario", "", codeUsage, "usage: verify-graph scenario run <journey>",
			"list journeys with: ls verification/scenarios").print()
	}
	return runOneJourney(p, flags, flags.rest[1], "scenario")
}

func verifyCommand(p paths, args []string) int {
	flags := parseFlags(args)
	references := []string{}
	if flags.has("all") {
		files, err := allJourneyPaths(p)
		if err != nil {
			return failEnvelope("verify", "", codeUsage, err.Error(),
				"restore verification/scenarios, then rerun verify-graph verify --all").print()
		}
		for _, file := range files {
			references = append(references, file)
		}
	}
	references = append(references, flags.all("journey")...)
	for _, rest := range flags.rest {
		references = append(references, rest)
	}
	if len(references) == 0 {
		return failEnvelope("verify", "", codeUsage, "no journey selected",
			"run: verify-graph verify --all, or verify-graph verify --journey rail-settings").print()
	}
	started := time.Now()
	summaries := []map[string]any{}
	failures := []string{}
	notes := []string{}
	artifacts := []artifact{}
	runID := flags.value("run", "")
	for _, reference := range references {
		value, err := resolveJourney(p, reference)
		if err != nil {
			failures = append(failures, err.Error())
			summaries = append(summaries, map[string]any{"journey": reference, "ok": false, "error": err.Error()})
			continue
		}
		meta, err := ensureRunForVerify(p, runID, flags.has("dry-run"))
		if err != nil {
			return failEnvelope("verify", "headless", codeDaemonDown, err.Error(), "run: verify-graph launch").print()
		}
		if runID == meta.RunID && !meta.isZero() && !runAlive(meta) {
			meta, err = ensureRunForVerify(p, "", false)
			if err != nil {
				return failEnvelope("verify", "headless", codeDaemonDown, "the run died and could not be replaced: "+err.Error(), "run: verify-graph launch").print()
			}
			notes = append(notes, fmt.Sprintf("%s: the previous instance was stopped by another process; relaunched as %s", value.ID, meta.RunID))
		}
		runID = meta.RunID
		outDir := filepath.Join(p.EvidenceRoot, meta.RunID, value.Feature)
		assertions := runPrepares(p, meta, value, outDir)
		result := runJourneyHeadless(p, meta, value, outDir)
		assertions = append(assertions, runChecks(p, meta, value, outDir)...)
		for _, item := range assertions[:len(value.Prepare)] {
			if !item.OK {
				result.OK = false
				result.Error = firstNonEmpty(result.Error, "prepare step failed: "+item.ID)
			}
		}
		_, written := writeEvidence(p, meta, value, result, assertions, outDir, started)
		artifacts = append(artifacts, written...)
		ok := result.OK
		for _, item := range assertions {
			if !item.OK {
				ok = false
			}
		}
		summaries = append(summaries, map[string]any{
			"journey": value.ID, "feature": value.Feature, "ok": ok,
			"steps": len(result.Steps), "checks": len(assertions),
			"error": result.Error, "evidence": outDir,
		})
		if !ok {
			failures = append(failures, fmt.Sprintf("%s: %s", value.ID, firstNonEmpty(result.Error, "an API check failed")))
		}
	}
	envelopeResult := okEnvelope("verify", "headless", map[string]any{
		"journeys": summaries, "passed": countTrue(summaries), "failed": len(summaries) - countTrue(summaries),
		"evidenceRoot": filepath.Join(p.EvidenceRoot, runID), "durationMs": time.Since(started).Milliseconds(),
		"relaunches": notes,
	})
	for _, note := range notes {
		envelopeResult.warn("%s", note)
	}
	envelopeResult.RunID = runID
	for _, item := range artifacts {
		envelopeResult.add(item)
	}
	if len(failures) > 0 {
		envelopeResult.OK = false
		envelopeResult.Error = &cliError{
			Code:    codeScenarioFailed,
			Message: strings.Join(failures, "; "),
			Hint:    "open the evidence directory above: summary.json names the failed assertion, assertions.json carries expected/actual",
		}
	}
	code := envelopeResult.print()
	if !flags.has("keep") && !flags.has("run") {
		stopRunQuietly(p, runID)
	}
	return code
}

func countTrue(items []map[string]any) int {
	count := 0
	for _, item := range items {
		if ok, _ := item["ok"].(bool); ok {
			count++
		}
	}
	return count
}

func ensureRunForVerify(p paths, runID string, dryRun bool) (runMeta, error) {
	if runID != "" {
		meta, err := readRunMeta(p, runID)
		if err != nil {
			return runMeta{}, err
		}
		if !runAlive(meta) {
			return runMeta{}, fmt.Errorf("run %s is not alive", runID)
		}
		return meta, nil
	}
	result, err := launch(p, launchOptions{Mode: "view", Timeout: 20 * time.Second, DryRun: dryRun})
	if err != nil {
		return runMeta{}, err
	}
	if !result.OK {
		return runMeta{}, fmt.Errorf("%s", result.Error.Message)
	}
	return readRunMeta(p, result.RunID)
}

func runOneJourney(p paths, flags flags, reference, command string) int {
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope(command, "headless", codeNoRun, err.Error(), "run: verify-graph launch").print()
	}
	if !runAlive(meta) {
		return failEnvelope(command, "headless", codeDaemonDown, "run "+meta.RunID+" is not alive", "run: verify-graph launch --run "+meta.RunID).print()
	}
	value, err := resolveJourney(p, reference)
	if err != nil {
		return failEnvelope(command, "headless", codeJourneyFileBroken, err.Error(), "list journeys with: ls verification/scenarios").print()
	}
	started := time.Now()
	outDir := filepath.Join(p.EvidenceRoot, meta.RunID, value.Feature)
	assertions := runPrepares(p, meta, value, outDir)
	result := runJourneyHeadless(p, meta, value, outDir)
	assertions = append(assertions, runChecks(p, meta, value, outDir)...)
	_, written := writeEvidence(p, meta, value, result, assertions, outDir, started)
	envelopeResult := okEnvelope(command, "headless", map[string]any{
		"journey": value.ID, "feature": value.Feature, "steps": result.Steps,
		"checks": assertions, "error": result.Error, "evidence": outDir, "output": result.Output,
	})
	envelopeResult.RunID = meta.RunID
	envelopeResult.OK = result.OK
	for _, item := range written {
		envelopeResult.add(item)
	}
	if !result.OK {
		envelopeResult.Error = &cliError{Code: codeScenarioFailed, Message: firstNonEmpty(result.Error, "the journey failed"),
			Hint: "read " + filepath.Join(outDir, "result.json") + " and the step list in data.steps"}
	}
	for _, item := range assertions {
		if !item.OK {
			envelopeResult.OK = false
			envelopeResult.Error = &cliError{Code: codeScenarioFailed,
				Message: "API check failed: " + item.ID + "; expected " + item.Expected + ", actual " + item.Actual,
				Hint:    "see " + item.Evidence}
		}
	}
	return envelopeResult.print()
}

func stopRunQuietly(p paths, runID string) {
	meta, err := readRunMeta(p, runID)
	if err != nil {
		return
	}
	_ = stopRun(p, meta)
}

func evidenceCommand(p paths, args []string) int {
	flags := parseFlags(args)
	if len(flags.rest) == 0 {
		return failEnvelope("evidence", "", codeUsage, "usage: verify-graph evidence list|verify",
			"try: verify-graph evidence list").print()
	}
	switch flags.rest[0] {
	case "list":
		root := p.EvidenceRoot
		if run := flags.value("run", ""); run != "" {
			root = filepath.Join(root, run)
		}
		entries := []map[string]any{}
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || info.Name() != "summary.json" {
				return nil
			}
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			var summary map[string]any
			if json.Unmarshal(raw, &summary) == nil {
				summary["dir"] = filepath.Dir(path)
				entries = append(entries, summary)
			}
			return nil
		})
		return okEnvelope("evidence", "", map[string]any{"root": root, "summaries": entries}).print()
	case "verify":
		run := flags.value("run", "")
		if run == "" && len(flags.rest) > 1 {
			run = flags.rest[1]
		}
		if run == "" {
			return failEnvelope("evidence", "", codeUsage, "a run id is required", "verify-graph evidence verify --run <id>").print()
		}
		root := filepath.Join(p.EvidenceRoot, run)
		problems := []string{}
		checked := 0
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || info.Name() != "manifest.json" {
				return nil
			}
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			var manifest struct {
				Files []struct {
					Path   string `json:"path"`
					SHA256 string `json:"sha256"`
				} `json:"files"`
			}
			if json.Unmarshal(raw, &manifest) != nil {
				problems = append(problems, "unreadable manifest: "+path)
				return nil
			}
			base := filepath.Dir(path)
			for _, file := range manifest.Files {
				checked++
				sum, _, sumErr := sha256File(filepath.Join(base, file.Path))
				if sumErr != nil || sum != file.SHA256 {
					problems = append(problems, fmt.Sprintf("%s changed (%s)", filepath.Join(base, file.Path), file.Path))
				}
			}
			return nil
		})
		result := okEnvelope("evidence", "", map[string]any{"run": run, "files": checked, "problems": problems})
		if len(problems) > 0 {
			result.OK = false
			result.Error = &cliError{Code: codeEvidenceCorrupt, Message: fmt.Sprintf("%d evidence file(s) no longer match their manifest", len(problems)),
				Hint: "rerun the journey that produced them: verify-graph verify --run " + run + " --journey <id>"}
		}
		return result.print()
	default:
		return failEnvelope("evidence", "", codeUsage, "unknown evidence verb "+flags.rest[0], "use: evidence list | evidence verify").print()
	}
}

func cleanupCommand(p paths, args []string) int {
	flags := parseFlags(args)
	dryRun := flags.has("dry-run")
	targets := []runMeta{}
	if flags.has("all") {
		runs, err := listRuns(p)
		if err != nil {
			return failEnvelope("cleanup", "", codeUsage, err.Error(), "check verification/.run").print()
		}
		targets = runs
	} else {
		runID := flags.value("run", "")
		if runID == "" && len(flags.rest) > 0 {
			runID = flags.rest[0]
		}
		meta, err := readRunMeta(p, runID)
		if err != nil {
			return failEnvelope("cleanup", "", codeNoRun, err.Error(), "run: verify-graph status").print()
		}
		targets = append(targets, meta)
	}
	report := []map[string]any{}
	failures := []string{}
	for _, meta := range targets {
		entry := map[string]any{"runId": meta.RunID, "pid": meta.Daemon.PID, "stateDir": meta.StateDir}
		if dryRun {
			entry["dryRun"] = true
			report = append(report, entry)
			continue
		}
		if problem := stopSeed(meta); problem != "" {
			failures = append(failures, problem)
		}
		if err := stopRun(p, meta); err != nil {
			failures = append(failures, err.Error())
			entry["error"] = err.Error()
			report = append(report, entry)
			continue
		}
		base := filepath.Dir(meta.StateDir)
		for _, name := range []string{"state", "graph-home", "home", "tmp", "runtime", "bin", "logs", "overlay", "project", "graph.config.json"} {
			_ = os.RemoveAll(filepath.Join(base, name))
		}
		_ = os.Remove(filepath.Join(base, "run.json"))
		_ = os.Remove(filepath.Join(base, seedRecordName))
		entry["removed"] = true
		report = append(report, entry)
	}
	result := okEnvelope("cleanup", "", map[string]any{"runs": report, "evidenceKept": p.EvidenceRoot})
	if len(failures) > 0 {
		result.OK = false
		result.Error = &cliError{Code: "cleanup-failed", Message: strings.Join(failures, "; "),
			Hint: "a pid may have been reused; confirm with: ps -o pid,lstart,command -p <pid>"}
	}
	return result.print()
}
