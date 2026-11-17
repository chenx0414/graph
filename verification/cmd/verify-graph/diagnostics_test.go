package main

import (
	"strings"
	"testing"
)

func TestAFailedJourneyExplainsItselfWithEvidenceAndNextCommand(t *testing.T) {
	meta := runMeta{RunID: "run-9"}
	value := journey{ID: "F-99-sample", Feature: "F-99", Description: "点击 洞察 后看到概览"}
	result := journeyResult{OK: false, Steps: []stepOutcome{
		{Index: 1, Verb: "click", OK: true},
		{Index: 2, Verb: "assertText", OK: false, Detail: "expected text 洞察概览; visible texts: 轨迹 | 洞察"},
	}}
	assertions := []assertion{
		{ID: "health", OK: true, Expected: "status 200", Actual: "status 200"},
		{ID: "insights-trend", OK: false, Expected: "status 200; stats.agents subset {\"agents\":0}",
			Actual: "status 200; stats.agents=3 (want subset {\"agents\":0})", Evidence: "/tmp/run-9/F-99/check-02.json"},
	}
	failure := describeFailure(meta, value, result, assertions, "/tmp/run-9/F-99")
	if failure["journey"] != "F-99-sample" || failure["feature"] != "F-99" || failure["runId"] != "run-9" {
		t.Fatalf("failure identity = %+v", failure)
	}
	if failure["path"] != "点击 洞察 后看到概览" {
		t.Fatalf("failure must carry the user path, got %+v", failure["path"])
	}
	if !strings.Contains(failure["expected"].(string), "assertText") {
		t.Fatalf("the first failed step is the expected answer, got %q", failure["expected"])
	}
	if !strings.Contains(failure["actual"].(string), "洞察概览") {
		t.Fatalf("the actual answer must quote what was on screen, got %q", failure["actual"])
	}
	if failure["evidence"] != "/tmp/run-9/F-99/check-02.json" {
		t.Fatalf("evidence must point at the failing assertion file, got %+v", failure["evidence"])
	}
	if failure["nextCommand"] != "verify-graph verify --journey F-99-sample" {
		t.Fatalf("nextCommand = %q; a verify --all run is stopped, so pinning --run would not execute", failure["nextCommand"])
	}
	steps := failure["failedSteps"].([]map[string]any)
	checks := failure["failedChecks"].([]map[string]any)
	if len(steps) != 1 || len(checks) != 1 {
		t.Fatalf("failed steps/checks = %d/%d", len(steps), len(checks))
	}
	if !strings.Contains(failure["message"].(string), "expected") || !strings.Contains(failure["message"].(string), "actual") {
		t.Fatalf("message = %q", failure["message"])
	}
}

func TestADriverErrorWithoutStepOutcomesStillNamesTheStep(t *testing.T) {
	// The window and surface lanes set result.Error but do not append a failed
	// stepOutcome. data.failures must still say which step and what happened.
	result := journeyResult{OK: false, Error: `step 1 (open): cannot open menu-bar-extras: the surface exposes no unnamed menu item to open`}
	failure := describeFailure(runMeta{RunID: "r"}, journey{ID: "F-15-tray", Feature: "F-15"}, result, nil, "/tmp/r/F-15")
	steps := failure["failedSteps"].([]map[string]any)
	if len(steps) != 1 {
		t.Fatalf("failedSteps = %+v", steps)
	}
	if steps[0]["index"].(int) != 1 || steps[0]["verb"] != "open" {
		t.Fatalf("step identity = %+v", steps[0])
	}
	if !strings.Contains(steps[0]["actual"].(string), "no unnamed menu item") {
		t.Fatalf("step actual = %q", steps[0]["actual"])
	}
	if !strings.Contains(failure["expected"].(string), "open") || !strings.Contains(failure["actual"].(string), "menu-bar-extras") {
		t.Fatalf("failure = %+v", failure)
	}
}

func TestTheNextCommandCarriesTheLaneAndNeverADeadRun(t *testing.T) {
	failure := describeFailure(runMeta{RunID: "stopped-run"}, journey{ID: "F-02-nav", Feature: "F-02"},
		journeyResult{OK: false, Lane: "window", Error: "step 1 (click): no window"}, nil, "/tmp/r/F-02")
	if failure["nextCommand"] != "verify-graph verify --journey F-02-nav --lane window" {
		t.Fatalf("nextCommand = %q", failure["nextCommand"])
	}
	if strings.Contains(failure["nextCommand"].(string), "stopped-run") {
		t.Fatalf("the hint must not pin a run that verify --all already stopped: %q", failure["nextCommand"])
	}
}
