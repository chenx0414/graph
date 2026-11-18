package eval

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"
)

func fixedClock() func() time.Time {
	moment := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return func() time.Time {
		moment = moment.Add(time.Second)
		return moment
	}
}

func passingCase(name, group string, layer Layer) Case {
	return Case{
		Name:  name,
		Group: group,
		Layer: layer,
		Run: func(t *T) {
			t.Equal("status", "ok", "ok")
		},
	}
}

func TestAnEmptyCaseListPasses(t *testing.T) {
	report := Run(nil, Options{Now: fixedClock()})
	if report.SchemaVersion != SchemaVersion {
		t.Fatalf("schemaVersion is %d", report.SchemaVersion)
	}
	if report.Total != 0 || report.Passed != 0 || report.Failed != 0 || report.Skipped != 0 {
		t.Fatalf("an empty run counted %+v", report)
	}
	if !report.Succeeded() {
		t.Fatal("an empty run must succeed")
	}
}

func TestPassingAssertionsMakeTheCasePassAndKeepEvidence(t *testing.T) {
	report := Run([]Case{passingCase("graph-create", "graph", LayerE2E)}, Options{Now: fixedClock()})
	if report.Total != 1 || report.Passed != 1 || report.Failed != 0 {
		t.Fatalf("counts are %+v", report)
	}
	got := report.Cases[0]
	if got.Status != StatusPassed || got.Name != "graph-create" || got.Group != "graph" || got.Layer != LayerE2E {
		t.Fatalf("case is %+v", got)
	}
	if len(got.Assertions) != 1 || got.Assertions[0].Name != "status" || !got.Assertions[0].OK {
		t.Fatalf("assertions are %+v", got.Assertions)
	}
}

func TestAFailedAssertionNamesWhatExpectedWhatAndIsTheOnlyFailure(t *testing.T) {
	failing := Case{
		Name:  "graph-run",
		Group: "graph",
		Layer: LayerE2E,
		Run: func(t *T) {
			t.Equal("revision", 1, 2)
			t.Equal("healthy", "yes", "yes")
		},
	}
	report := Run([]Case{failing, passingCase("graph-inspect", "graph", LayerE2E)}, Options{Now: fixedClock()})
	if report.Failed != 1 || report.Passed != 1 {
		t.Fatalf("counts are %+v", report)
	}
	first := report.Cases[0]
	if first.Status != StatusFailed {
		t.Fatalf("status is %q", first.Status)
	}
	if len(first.Assertions) != 2 {
		t.Fatalf("both assertions must be recorded, got %+v", first.Assertions)
	}
	if first.Assertions[0].OK || first.Assertions[0].Name != "revision" {
		t.Fatalf("the failed assertion is %+v", first.Assertions[0])
	}
	if first.Assertions[0].Expected != "1" || first.Assertions[0].Actual != "2" {
		t.Fatalf("expected/actual are %q/%q", first.Assertions[0].Expected, first.Assertions[0].Actual)
	}
	if !first.Assertions[1].OK {
		t.Fatalf("the assertion after a failure must still run, got %+v", first.Assertions[1])
	}
	if report.Cases[1].Status != StatusPassed {
		t.Fatalf("a later case must still run, got %+v", report.Cases[1])
	}
}

func TestRenderingExpectedAndActualIsStableForSlicesAndStructs(t *testing.T) {
	type row struct {
		ID   string `json:"id"`
		Done bool   `json:"done"`
	}
	report := Run([]Case{{
		Name:  "rsi",
		Group: "rsi",
		Layer: LayerIntegration,
		Run: func(t *T) {
			t.Equal("files", []string{"b.go", "a.go"}, []string{"a.go"})
			t.Equal("row", row{ID: "x", Done: true}, row{ID: "x"})
		},
	}}, Options{Now: fixedClock()})
	assertions := report.Cases[0].Assertions
	if assertions[0].Expected != `["b.go","a.go"]` || assertions[0].Actual != `["a.go"]` {
		t.Fatalf("slices render as %q / %q", assertions[0].Expected, assertions[0].Actual)
	}
	if assertions[1].Expected != `{"id":"x","done":true}` {
		t.Fatalf("structs render as %q", assertions[1].Expected)
	}
}

func TestAPanicInsideACaseBecomesAFailureAndTheRunContinues(t *testing.T) {
	report := Run([]Case{
		{Name: "boom", Group: "graph", Layer: LayerE2E, Run: func(t *T) { panic("definition is not a map") }},
		passingCase("after", "graph", LayerE2E),
	}, Options{Now: fixedClock()})
	if report.Failed != 1 || report.Passed != 1 {
		t.Fatalf("counts are %+v", report)
	}
	failed := report.Cases[0]
	if failed.Status != StatusFailed || !strings.Contains(failed.Error, "definition is not a map") {
		t.Fatalf("panic was recorded as %+v", failed)
	}
	if failed.ErrorDetail != "panic" {
		t.Fatalf("error detail is %q", failed.ErrorDetail)
	}
}

func TestSetupFailureSkipsRunAndIsRecorded(t *testing.T) {
	ran := false
	report := Run([]Case{{
		Name:  "sandbox",
		Group: "sandbox",
		Layer: LayerIntegration,
		Setup: func(t *T) { t.Fail("fixture", errors.New("no checkout")) },
		Run:   func(t *T) { ran = true },
	}}, Options{Now: fixedClock()})
	if ran {
		t.Fatal("Run must not start when Setup failed")
	}
	if report.Failed != 1 || report.Cases[0].Status != StatusFailed {
		t.Fatalf("counts are %+v", report)
	}
	if !strings.Contains(report.Cases[0].Error, "no checkout") {
		t.Fatalf("setup error is %q", report.Cases[0].Error)
	}
}

func TestSkippedCasesAreReportedWithoutFailingTheRun(t *testing.T) {
	report := Run([]Case{
		{
			Name:  "sandbox-command",
			Group: "sandbox",
			Layer: LayerE2E,
			Run:   func(t *T) { t.Skip("the restricted executor API is being rewritten") },
		},
		passingCase("graph-create", "graph", LayerE2E),
	}, Options{Now: fixedClock()})
	if report.Skipped != 1 || report.Passed != 1 || report.Failed != 0 {
		t.Fatalf("counts are %+v", report)
	}
	skipped := report.Cases[0]
	if skipped.Status != StatusSkipped || !strings.Contains(skipped.SkipReason, "restricted executor") {
		t.Fatalf("skip is %+v", skipped)
	}
	if !report.Succeeded() {
		t.Fatal("a skip must not fail the run")
	}
}

func TestFiltersSelectByLayerGroupAndName(t *testing.T) {
	cases := []Case{
		passingCase("a", "graph", LayerE2E),
		passingCase("b", "graph", LayerIntegration),
		passingCase("c", "rsi", LayerIntegration),
	}
	onlyLayer := Run(cases, Options{Now: fixedClock(), Layer: LayerIntegration})
	if onlyLayer.Total != 2 || names(onlyLayer) != "b,c" {
		t.Fatalf("layer filter ran %s", names(onlyLayer))
	}
	onlyGroup := Run(cases, Options{Now: fixedClock(), Group: "rsi"})
	if onlyGroup.Total != 1 || names(onlyGroup) != "c" {
		t.Fatalf("group filter ran %s", names(onlyGroup))
	}
	onlyCase := Run(cases, Options{Now: fixedClock(), Case: "a"})
	if onlyCase.Total != 1 || names(onlyCase) != "a" {
		t.Fatalf("case filter ran %s", names(onlyCase))
	}
	everything := Run(cases, Options{Now: fixedClock(), Layer: "all", Group: "all"})
	if everything.Total != 3 {
		t.Fatalf("all filter ran %s", names(everything))
	}
}

func TestTheReportJSONKeepsItsShape(t *testing.T) {
	report := Run([]Case{
		passingCase("graph-create", "graph", LayerE2E),
		{Name: "broken", Group: "graph", Layer: LayerE2E, Run: func(t *T) { t.Equal("ok", true, false) }},
		{Name: "absent", Group: "sandbox", Layer: LayerE2E, Run: func(t *T) { t.Skip("waiting") }},
	}, Options{Now: fixedClock()})
	payload, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	wantTop := "cases,elapsedMs,failed,finishedAt,passed,schemaVersion,skipped,startedAt,total"
	if got := keys(decoded); got != wantTop {
		t.Fatalf("report keys are %s, want %s", got, wantTop)
	}
	cases, ok := decoded["cases"].([]any)
	if !ok || len(cases) != 3 {
		t.Fatalf("cases are %T %v", decoded["cases"], decoded["cases"])
	}
	first, _ := cases[0].(map[string]any)
	wantCase := "assertions,elapsedMs,group,layer,name,status"
	if got := keys(first); got != wantCase {
		t.Fatalf("case keys are %s, want %s", got, wantCase)
	}
	assertions, _ := first["assertions"].([]any)
	firstAssertion, _ := assertions[0].(map[string]any)
	wantAssertion := "actual,expected,name,ok"
	if got := keys(firstAssertion); got != wantAssertion {
		t.Fatalf("assertion keys are %s, want %s", got, wantAssertion)
	}
	if decoded["schemaVersion"] != float64(SchemaVersion) {
		t.Fatalf("schemaVersion is %v", decoded["schemaVersion"])
	}
	if report.StartedAt != "2026-01-02T03:04:06Z" || report.FinishedAt == "" {
		t.Fatalf("timestamps are %q / %q", report.StartedAt, report.FinishedAt)
	}
	for _, item := range cases {
		record := item.(map[string]any)
		if _, ok := record["skipReason"]; !ok && record["status"] == string(StatusSkipped) {
			t.Fatalf("a skipped case must carry skipReason: %v", record)
		}
	}
}

func TestTheReportCarriesTheContractEachCasePins(t *testing.T) {
	report := Run([]Case{{
		Name:     "graph-create",
		Group:    "graph",
		Layer:    LayerE2E,
		Contract: "POST /api/graphs admits every node of a schemaVersion 2 definition",
		Run:      func(t *T) { t.Equal("revision", 1, 1) },
	}}, Options{Now: fixedClock()})
	if report.Cases[0].Contract == "" {
		t.Fatal("the case must name the product contract it pins")
	}
}

func names(report Report) string {
	collected := make([]string, 0, len(report.Cases))
	for _, item := range report.Cases {
		collected = append(collected, item.Name)
	}
	return strings.Join(collected, ",")
}

func keys(record map[string]any) string {
	collected := make([]string, 0, len(record))
	for key := range record {
		collected = append(collected, key)
	}
	sort.Strings(collected)
	return strings.Join(collected, ",")
}

func TestASkippedCaseCarriesNoError(t *testing.T) {
	report := Run([]Case{{
		Name:  "sandbox",
		Group: "sandbox",
		Layer: LayerIntegration,
		Run:   func(t *T) { t.Skip("the execution surface is in flux") },
	}}, Options{Now: fixedClock()})
	record := report.Cases[0]
	if record.Status != StatusSkipped {
		t.Fatalf("status is %q", record.Status)
	}
	if record.Error != "" || record.ErrorDetail != "" {
		t.Fatalf("a skipped case must carry no error, got %q / %q", record.Error, record.ErrorDetail)
	}
	if record.SkipReason == "" {
		t.Fatal("a skipped case must say why")
	}
	payload, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(payload), `"error"`) || strings.Contains(string(payload), `"errorDetail"`) {
		t.Fatalf("the skipped record still serializes an error: %s", payload)
	}
}
