package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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
		record := assertion{ID: id, Expected: expectationsText(check)}
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
		for _, key := range sortedKeys(check.Expect) {
			matched, problem := matchValue(parsed, key, check.Expect[key], false)
			if !matched {
				ok = false
				actual += "; " + problem
			}
		}
		for _, key := range sortedKeys(check.ExpectExact) {
			matched, problem := matchValue(parsed, key, check.ExpectExact[key], true)
			if !matched {
				ok = false
				actual += "; " + problem
			}
		}
		record.OK = ok
		record.Actual = actual
		path := filepath.Join(outDir, fmt.Sprintf("%s-%02d.json", prefix, index+1))
		payloadOut, _ := json.MarshalIndent(checkEvidence(check, status, parsed), "", "  ")
		if err := os.WriteFile(path, payloadOut, 0o644); err != nil {
			record.Actual += "; evidence not written: " + err.Error()
		} else {
			record.Evidence = path
		}
		assertions = append(assertions, record)
	}
	return assertions
}

// checkEvidence is the JSON document written for one API check. The body is
// kept verbatim even when it is large: it is the evidence for a check, and the
// repository's file-budget directive is the sanctioned way to say so. The
// `_graph` marker is read by `graphcheck tokens` (see backend/internal/gate).
func checkEvidence(check apiCheck, status int, parsed any) map[string]any {
	return map[string]any{
		"_graph":  "graph:allow-large-file: raw daemon response kept as evidence; generated data, not source",
		"request": check,
		"status":  status,
		"body":    parsed,
	}
}

func expectationsText(check apiCheck) string {
	parts := []string{fmt.Sprintf("status %d", check.ExpectStatus)}
	for _, key := range sortedKeys(check.Expect) {
		parts = append(parts, fmt.Sprintf("%s contains %s", key, renderJSON(check.Expect[key])))
	}
	for _, key := range sortedKeys(check.ExpectExact) {
		parts = append(parts, fmt.Sprintf("%s == %s", key, renderJSON(check.ExpectExact[key])))
	}
	return strings.Join(parts, "; ")
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func matchValue(root any, dotted string, want any, exact bool) (bool, string) {
	got, found := lookupOK(root, dotted)
	if !found {
		return false, fmt.Sprintf("%s is missing (want %s)", dotted, renderJSON(want))
	}
	if exact {
		if detail := exactProblem("", want, got); detail != "" {
			return false, fmt.Sprintf("%s%s=%s (want exactly %s)", dotted, detail, renderJSON(got), renderJSON(want))
		}
		return true, ""
	}
	if detail := subsetProblem("", want, got); detail != "" {
		return false, fmt.Sprintf("%s%s=%s (want subset %s)", dotted, detail, renderJSON(got), renderJSON(want))
	}
	return true, ""
}

func subsetProblem(path string, want, got any) string {
	switch expected := want.(type) {
	case map[string]any:
		actual, ok := got.(map[string]any)
		if !ok {
			return path + " is not an object"
		}
		for _, key := range sortedKeys(expected) {
			value, exists := actual[key]
			if !exists {
				return path + "." + key + " is missing"
			}
			if detail := subsetProblem(path+"."+key, expected[key], value); detail != "" {
				return detail
			}
		}
		return ""
	case []any:
		actual, ok := got.([]any)
		if !ok {
			return path + " is not an array"
		}
		if len(actual) != len(expected) {
			return fmt.Sprintf("%s has %d item(s), want %d", path, len(actual), len(expected))
		}
		for index := range expected {
			if detail := subsetProblem(fmt.Sprintf("%s[%d]", path, index), expected[index], actual[index]); detail != "" {
				return detail
			}
		}
		return ""
	default:
		if !valuesEqual(got, want) {
			return path + " differs"
		}
		return ""
	}
}

func exactProblem(path string, want, got any) string {
	switch expected := want.(type) {
	case map[string]any:
		actual, ok := got.(map[string]any)
		if !ok {
			return path + " is not an object"
		}
		if len(actual) != len(expected) {
			return fmt.Sprintf("%s has %d key(s), want exactly %d", path, len(actual), len(expected))
		}
		for _, key := range sortedKeys(expected) {
			value, exists := actual[key]
			if !exists {
				return path + "." + key + " is missing"
			}
			if detail := exactProblem(path+"."+key, expected[key], value); detail != "" {
				return detail
			}
		}
		return ""
	case []any:
		actual, ok := got.([]any)
		if !ok {
			return path + " is not an array"
		}
		if len(actual) != len(expected) {
			return fmt.Sprintf("%s has %d item(s), want exactly %d", path, len(actual), len(expected))
		}
		for index := range expected {
			if detail := exactProblem(fmt.Sprintf("%s[%d]", path, index), expected[index], actual[index]); detail != "" {
				return detail
			}
		}
		return ""
	default:
		if !valuesEqual(got, want) {
			return path + " differs"
		}
		return ""
	}
}

func valuesEqual(left, right any) bool {
	if leftNumber, ok := asNumber(left); ok {
		if rightNumber, ok := asNumber(right); ok {
			return leftNumber == rightNumber
		}
		return false
	}
	return reflect.DeepEqual(left, right)
}

func asNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case json.Number:
		parsed, err := number.Float64()
		return parsed, err == nil
	}
	return 0, false
}

func lookupOK(value any, dotted string) (any, bool) {
	current := value
	for _, part := range strings.Split(dotted, ".") {
		switch node := current.(type) {
		case map[string]any:
			next, ok := node[part]
			if !ok {
				return nil, false
			}
			current = next
		default:
			return nil, false
		}
	}
	return current, true
}

func renderJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(raw)
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

// markEvidenceFile adds the repository's file-budget directive to a generated
// journey result. A result keeps the whole visible text of the final frame, and
// that text is the proof a reviewer reads; it is not source that can be split.
// The manifest is written after this call, so the hash covers the marked file.
func markEvidenceFile(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		return
	}
	if _, exists := document["_graph"]; exists {
		return
	}
	document["_graph"] = "graph:allow-large-file: generated journey evidence kept verbatim; generated data, not source"
	out, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, append(out, '\n'), 0o644)
}

func writeEvidence(p paths, meta runMeta, value journey, result journeyResult, assertions []assertion, outDir string, started time.Time) (string, []artifact) {
	_ = os.MkdirAll(outDir, 0o755)
	lane := firstNonEmpty(result.Lane, "headless")
	artifacts := []artifact{}
	for _, frame := range result.Frames {
		artifacts = append(artifacts, fileArtifact("png", frame, lane+" frame for "+value.Feature))
	}
	driverResult := filepath.Join(outDir, "result.json")
	if !fileExists(driverResult) {
		raw, _ := json.MarshalIndent(result, "", "  ")
		_ = os.WriteFile(driverResult, raw, 0o644)
	}
	markEvidenceFile(driverResult)
	artifacts = append(artifacts, fileArtifact("json", driverResult, lane+" journey result"))
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
		"commit": meta.GitHead, "lane": lane, "error": result.Error,
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
