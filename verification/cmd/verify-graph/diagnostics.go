package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// stepErrorPattern is the shape every lane's fail() writes: "step 3 (click): …".
// The window and surface lanes do not append a stepOutcome on failure, so the
// error string is the only place the failing step is named; parsing it keeps
// data.failures just as specific as the headless lane's.
var stepErrorPattern = regexp.MustCompile(`^step (\d+) \(([^)]+)\): (.*)$`)

// describeFailure turns a red journey into the answer the user asked for:
// which user path, what was expected, what actually happened, where the proof
// lives, and the one command that reproduces just this path. It never replaces
// the evidence files; it points at them.
func describeFailure(meta runMeta, value journey, result journeyResult, assertions []assertion, outDir string) map[string]any {
	failedSteps := []map[string]any{}
	for _, step := range result.Steps {
		if step.OK {
			continue
		}
		failedSteps = append(failedSteps, map[string]any{
			"index": step.Index, "verb": step.Verb,
			"expected": fmt.Sprintf("step %d (%s) succeeds", step.Index, step.Verb),
			"actual":   firstNonEmpty(step.Detail, "the step failed without a detail"),
		})
	}
	failedChecks := []map[string]any{}
	for _, item := range assertions {
		if item.OK {
			continue
		}
		failedChecks = append(failedChecks, map[string]any{
			"id": item.ID, "expected": firstNonEmpty(item.Expected, "the assertion holds"),
			"actual": item.Actual, "evidence": item.Evidence,
		})
	}
	if len(failedSteps) == 0 && strings.TrimSpace(result.Error) != "" {
		if match := stepErrorPattern.FindStringSubmatch(strings.TrimSpace(result.Error)); match != nil {
			failedSteps = append(failedSteps, map[string]any{
				"index": parseIntOrZero(match[1]), "verb": match[2],
				"expected": fmt.Sprintf("step %s (%s) succeeds", match[1], match[2]),
				"actual":   match[3],
			})
		}
	}
	expected := "every step and API check in this journey passes"
	actual := firstNonEmpty(result.Error, "a check failed")
	if len(failedSteps) > 0 {
		expected = failedSteps[0]["expected"].(string)
		actual = failedSteps[0]["actual"].(string)
	} else if len(failedChecks) > 0 {
		expected = failedChecks[0]["expected"].(string)
		actual = failedChecks[0]["actual"].(string)
	} else if strings.TrimSpace(result.Error) != "" {
		expected = "the journey's driver opens and every step runs"
		actual = result.Error
	}
	evidence := outDir
	if len(failedChecks) > 0 {
		if path, ok := failedChecks[0]["evidence"].(string); ok && path != "" {
			evidence = path
		}
	}
	// The next command must work from a clean shell. A verify --all run is
	// stopped when it finishes (unless --keep), so a hint that pins --run to
	// that dead id would be unexecutable. Reproduce with a fresh isolated run;
	// the failure already carries runId for the stopped run's evidence.
	next := fmt.Sprintf("verify-graph verify --journey %s", value.ID)
	if result.Lane == "window" {
		next += " --lane window"
	}
	return map[string]any{
		"journey": value.ID, "feature": value.Feature, "runId": meta.RunID,
		"path":     firstNonEmpty(value.Description, value.ID),
		"expected": expected, "actual": actual,
		"failedSteps": failedSteps, "failedChecks": failedChecks,
		"evidence": evidence, "summary": filepath.Join(outDir, "summary.json"),
		"nextCommand": next,
		"message":     fmt.Sprintf("%s (%s): expected %s; actual %s", value.ID, value.Feature, expected, truncate(actual, 240)),
	}
}

func parseIntOrZero(raw string) int {
	value := 0
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0
		}
		value = value*10 + int(char-'0')
	}
	return value
}
