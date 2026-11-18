package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chenx0414/graph/backend/eval"
)

func fixtures() []eval.Case {
	return []eval.Case{
		{
			Name:     "green",
			Group:    "graph",
			Layer:    eval.LayerE2E,
			Contract: "a passing case keeps its evidence",
			Run:      func(t *eval.T) { t.Equal("status", "ok", "ok") },
		},
		{
			Name:  "red",
			Group: "graph",
			Layer: eval.LayerE2E,
			Run:   func(t *eval.T) { t.Equal("revision", 1, 2) },
		},
		{
			Name:  "slow",
			Group: "rsi",
			Layer: eval.LayerIntegration,
			Run:   func(t *eval.T) { t.Skip("fixture is not ready") },
		},
	}
}

func TestTheExitCodeIsZeroOnlyWhenEveryCasePassed(t *testing.T) {
	if code := exitCode(eval.Report{Failed: 0}); code != 0 {
		t.Fatalf("a clean report exits %d", code)
	}
	if code := exitCode(eval.Report{Failed: 1}); code != 1 {
		t.Fatalf("a failed report exits %d", code)
	}
	if code := exitCode(eval.Report{Skipped: 2}); code != 0 {
		t.Fatalf("a skip-only report exits %d", code)
	}
}

func TestUsageErrorsExitTwo(t *testing.T) {
	for _, argv := range [][]string{{"--layer", "nightly"}, {"--nope"}, {"--group"}} {
		if _, err := parseArguments(argv); err == nil || err == errHelp {
			t.Fatalf("%v must be a usage error, got %v", argv, err)
		}
	}
	if _, err := parseArguments([]string{"--help"}); err != errHelp {
		t.Fatalf("--help must be recognized as help, got %v", err)
	}
}

func TestArgumentsSelectLayerGroupAndName(t *testing.T) {
	options, err := parseArguments([]string{"--layer", "e2e", "--group", "graph", "--case", "green", "--json", "--no-save"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if options.Layer != eval.Layer("e2e") || options.Group != "graph" || options.Case != "green" {
		t.Fatalf("options are %+v", options)
	}
	if !options.JSON || options.Save {
		t.Fatalf("json/no-save are %+v", options)
	}
	defaults, err := parseArguments(nil)
	if err != nil {
		t.Fatalf("parse defaults: %v", err)
	}
	if defaults.Layer != eval.Layer("all") || defaults.Group != "all" || !defaults.Save || defaults.JSON {
		t.Fatalf("defaults are %+v", defaults)
	}
}

func TestUnknownFlagsAndLayersAreRejected(t *testing.T) {
	for _, argv := range [][]string{
		{"--nope"},
		{"--layer", "nightly"},
		{"--group"},
		{"--layer", "e2e", "extra"},
	} {
		if _, err := parseArguments(argv); err == nil {
			t.Fatalf("%v was accepted", argv)
		}
	}
	for _, argv := range [][]string{{"--layer", "e2e"}, {"--layer", "integration"}, {"--layer", "all"}} {
		if _, err := parseArguments(argv); err != nil {
			t.Fatalf("%v was rejected: %v", argv, err)
		}
	}
}

func TestTheSavedReportNamesItsRunAndKeepsTheSameShape(t *testing.T) {
	directory := t.TempDir()
	report := eval.Run(fixtures(), eval.Options{Layer: "all", Group: "all"})
	path, err := saveReport(directory, report, fixedNow)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	want := filepath.Join(directory, "eval", "report-20260102T030406Z.json")
	if path != want {
		t.Fatalf("report path is %q, want %q", path, want)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var decoded eval.Report
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.SchemaVersion != report.SchemaVersion || len(decoded.Cases) != len(report.Cases) {
		t.Fatalf("saved report is %+v", decoded)
	}
	if decoded.Failed != 1 || decoded.Passed != 1 || decoded.Skipped != 1 {
		t.Fatalf("saved counts are %+v", decoded)
	}
}

func TestALineSummaryNamesEachCaseAndTheOneThatFailed(t *testing.T) {
	report := eval.Run(fixtures(), eval.Options{Layer: "all", Group: "all"})
	lines := summaryLines(report)
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"red", "revision: expected 1, got 2", "1 case(s) failed"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("summary is missing %q:\n%s", want, joined)
		}
	}
}

func TestTheStateDirectoryComesFromTheRepositoryLayout(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	nested := filepath.Join(root, "backend", "eval")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir all: %v", err)
	}
	found, err := repoRootOf(nested)
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	if found != root {
		t.Fatalf("repo root is %q, want %q", found, root)
	}
}
