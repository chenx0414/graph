package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type assertion struct {
	ID       string `json:"id"`
	OK       bool   `json:"ok"`
	Expected string `json:"expected,omitempty"`
	Actual   string `json:"actual,omitempty"`
	Evidence string `json:"evidence,omitempty"`
}

func runChecks(p paths, meta runMeta, value journey, outDir string) []assertion {
	return runCheckList(meta, value.Checks, outDir, "check")
}

func runPrepares(p paths, meta runMeta, value journey, outDir string) []assertion {
	return runCheckList(meta, value.Prepare, outDir, "prepare")
}

func runCheckList(meta runMeta, checks []apiCheck, outDir string, prefix string) []assertion {
	assertions := []assertion{}
	_ = os.MkdirAll(outDir, 0o755)
	client := newAPIClient(meta.Daemon.URL, readToken(meta.StateDir))
	for index, check := range checks {
		id := check.ID
		if id == "" {
			id = fmt.Sprintf("%s-%02d %s %s", prefix, index+1, check.Method, check.Path)
		}
		method := strings.ToUpper(firstNonEmpty(check.Method, "GET"))
		status, payload, err := client.do(method, check.Path, check.Body)
		record := assertion{ID: id, Expected: fmt.Sprintf("status %d", check.ExpectStatus)}
		actual := fmt.Sprintf("status %d", status)
		ok := true
		if err != nil {
			ok = false
			actual = err.Error()
		}
		if check.ExpectStatus > 0 && status != check.ExpectStatus {
			ok = false
		}
		var parsed any
		if json.Unmarshal(payload, &parsed) != nil {
			parsed = string(payload)
		}
		for key, want := range check.Expect {
			got := lookup(parsed, key)
			if fmt.Sprint(got) != fmt.Sprint(want) {
				ok = false
				actual += fmt.Sprintf("; %s=%v (want %v)", key, got, want)
			}
		}
		record.OK = ok
		record.Actual = actual
		path := filepath.Join(outDir, fmt.Sprintf("%s-%02d.json", prefix, index+1))
		payloadOut, _ := json.MarshalIndent(map[string]any{"request": check, "status": status, "body": parsed}, "", "  ")
		if err := os.WriteFile(path, payloadOut, 0o644); err != nil {
			record.Actual += "; evidence not written: " + err.Error()
		} else {
			record.Evidence = path
		}
		assertions = append(assertions, record)
	}
	return assertions
}

func lookup(value any, dotted string) any {
	current := value
	for _, part := range strings.Split(dotted, ".") {
		switch node := current.(type) {
		case map[string]any:
			current = node[part]
		default:
			return nil
		}
	}
	return current
}

func writeManifest(dir string) (string, error) {
	entries := []map[string]any{}
	paths := []string{}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || info.Name() == "manifest.json" || info.Name() == "summary.json" {
			return nil
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)
	for _, path := range paths {
		sum, size, err := sha256File(path)
		if err != nil {
			return "", err
		}
		relative, _ := filepath.Rel(dir, path)
		entries = append(entries, map[string]any{"path": relative, "sha256": sum, "bytes": size})
	}
	raw, err := json.MarshalIndent(map[string]any{"files": entries, "createdAt": time.Now().UTC().Format(time.RFC3339)}, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func countSkippedSteps(steps []stepOutcome) int {
	skipped := 0
	for _, step := range steps {
		if step.Skipped {
			skipped++
		}
	}
	return skipped
}

func writeEvidence(p paths, meta runMeta, value journey, result journeyResult, assertions []assertion, outDir string, started time.Time) (string, []artifact) {
	_ = os.MkdirAll(outDir, 0o755)
	artifacts := []artifact{}
	for _, frame := range result.Frames {
		artifacts = append(artifacts, fileArtifact("png", frame, "headless render frame for "+value.Feature))
	}
	driverResult := filepath.Join(outDir, "result.json")
	if !fileExists(driverResult) {
		raw, _ := json.MarshalIndent(result, "", "  ")
		_ = os.WriteFile(driverResult, raw, 0o644)
	}
	artifacts = append(artifacts, fileArtifact("json", driverResult, "headless journey result"))
	assertionPath := filepath.Join(outDir, "assertions.json")
	assertionRaw, _ := json.MarshalIndent(assertions, "", "  ")
	if err := os.WriteFile(assertionPath, assertionRaw, 0o644); err != nil {
		return "", artifacts
	}
	artifacts = append(artifacts, fileArtifact("json", assertionPath, "assertions"))
	passed, failed := 0, 0
	for _, item := range assertions {
		if item.OK {
			passed++
		} else {
			failed++
		}
	}
	skipped := countSkippedSteps(result.Steps)
	summary := map[string]any{
		"scenario": value.ID, "feature": value.Feature, "run": meta.RunID, "ok": result.OK && failed == 0,
		"passed": passed, "failed": failed, "steps": len(result.Steps), "skippedSteps": skipped,
		"startedAt": started.UTC().Format(time.RFC3339), "endedAt": time.Now().UTC().Format(time.RFC3339),
		"commit": meta.GitHead, "lane": "headless", "error": result.Error,
	}
	summaryPath := filepath.Join(outDir, "summary.json")
	summaryRaw, _ := json.MarshalIndent(summary, "", "  ")
	if err := os.WriteFile(summaryPath, summaryRaw, 0o644); err != nil {
		return "", artifacts
	}
	artifacts = append(artifacts, fileArtifact("json", summaryPath, "scenario summary"))
	if manifest, err := writeManifest(outDir); err == nil {
		artifacts = append(artifacts, fileArtifact("json", manifest, "evidence manifest"))
	}
	return outDir, artifacts
}
