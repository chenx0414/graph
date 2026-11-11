package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/chenx0414/graph/backend/internal/harness"
)

func runHarness(repoRoot string, arguments []string) int {
	record := false
	statePath := filepath.Join(repoRoot, "backend", "internal", "graph", "testdata", "harness-surface.json")
	timeout := harness.ParseTimeout(os.Getenv("GRAPH_EVAL_TIMEOUT_MS"))
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "--record":
			record = true
		case "--state":
			index++
			statePath = valueAt(arguments, index)
			record = true
		case "--help", "-h":
			fmt.Println("usage: graphcheck harness [--record] [--state <path>]")
			return 0
		default:
			fmt.Fprintf(os.Stderr, "graphcheck harness: unknown argument %s\n", arguments[index])
			return 2
		}
	}
	code, err := harness.Gate(harness.GateOptions{
		Repository: repoRoot,
		StatePath:  statePath,
		Record:     record,
		Timeout:    timeout,
		Print:      func(line string) { fmt.Print(line) },
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcheck harness: %v\n", err)
		return 2
	}
	return code
}

func runEval(repoRoot string, arguments []string) int {
	caseID, configPath := "parser", ""
	timeout := harness.ParseTimeout(os.Getenv("GRAPH_EVAL_TIMEOUT_MS"))
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "--case":
			index++
			caseID = valueAt(arguments, index)
		case "--config":
			index++
			configPath = valueAt(arguments, index)
		case "--timeout-ms":
			index++
			timeout = harness.ParseTimeout(valueAt(arguments, index))
		case "--help", "-h":
			fmt.Println("usage: graphcheck eval [--case parser|cli|persistence] [--config <graph.config.json>] [--timeout-ms N]")
			return 0
		default:
			if caseID == "parser" && harness.Cases[arguments[index]].ID != "" {
				caseID = arguments[index]
				continue
			}
			fmt.Fprintf(os.Stderr, "graphcheck eval: unknown argument %s\n", arguments[index])
			return 2
		}
	}
	report := harness.Run(harness.Options{Repository: repoRoot, CaseID: caseID, Timeout: timeout, ConfigPath: configPath})
	payload, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcheck eval: %v\n", err)
		return 2
	}
	fmt.Println(string(payload))
	if !report.TaskSuccess {
		fmt.Fprintf(os.Stderr, "graphcheck eval: %s did not complete\n", caseID)
		return 1
	}
	return 0
}
