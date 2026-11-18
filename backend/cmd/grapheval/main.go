package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/chenx0414/graph/backend/eval"
)

type arguments struct {
	Layer eval.Layer
	Group string
	Case  string
	JSON  bool
	Save  bool
}

func fixedNow() time.Time {
	return time.Date(2026, 1, 2, 3, 4, 6, 0, time.UTC)
}

func parseArguments(argv []string) (arguments, error) {
	options := arguments{Layer: eval.Layer("all"), Group: "all", Save: true}
	for index := 0; index < len(argv); index++ {
		argument := argv[index]
		if !strings.HasPrefix(argument, "--") {
			return options, fmt.Errorf("unexpected argument %q", argument)
		}
		name, inline, hasInline := strings.Cut(strings.TrimPrefix(argument, "--"), "=")
		value := func() (string, error) {
			if hasInline {
				return inline, nil
			}
			if index+1 >= len(argv) || strings.HasPrefix(argv[index+1], "--") {
				return "", fmt.Errorf("--%s requires a value", name)
			}
			index++
			return argv[index], nil
		}
		switch name {
		case "layer":
			raw, err := value()
			if err != nil {
				return options, err
			}
			if raw != "all" && raw != string(eval.LayerE2E) && raw != string(eval.LayerIntegration) {
				return options, fmt.Errorf("--layer takes e2e, integration or all, got %q", raw)
			}
			options.Layer = eval.Layer(raw)
		case "group":
			raw, err := value()
			if err != nil {
				return options, err
			}
			if strings.TrimSpace(raw) == "" {
				return options, fmt.Errorf("--group requires a value")
			}
			options.Group = raw
		case "case":
			raw, err := value()
			if err != nil {
				return options, err
			}
			if strings.TrimSpace(raw) == "" {
				return options, fmt.Errorf("--case requires a value")
			}
			options.Case = raw
		case "json":
			options.JSON = true
			options.Save = false
			if hasInline {
				return options, fmt.Errorf("--json takes no value")
			}
		case "save":
			options.Save = true
		case "no-save":
			options.Save = false
		case "help", "h":
			return options, errHelp
		default:
			return options, fmt.Errorf("unknown argument %q", argument)
		}
	}
	return options, nil
}

var errHelp = fmt.Errorf("help")

func exitCode(report eval.Report) int {
	if report.Failed > 0 {
		return 1
	}
	return 0
}

func saveReport(stateDir string, report eval.Report, now func() time.Time) (string, error) {
	directory := filepath.Join(stateDir, "eval")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	stamp := now().UTC().Format("20060102T150405Z")
	path := filepath.Join(directory, "report-"+stamp+".json")
	payload, err := report.MarshalIndent()
	if err != nil {
		return "", err
	}
	pending := path + ".pending"
	if err := os.WriteFile(pending, append(payload, '\n'), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(pending, path); err != nil {
		return "", err
	}
	return path, nil
}

func summaryLines(report eval.Report) []string {
	lines := make([]string, 0, len(report.Cases)+4)
	for _, item := range report.Cases {
		mark := "ok  "
		if item.Status == eval.StatusFailed {
			mark = "FAIL"
		} else if item.Status == eval.StatusSkipped {
			mark = "skip"
		}
		lines = append(lines, mark+" "+item.Name+" ("+item.Group+" "+string(item.Layer)+")")
		if item.Status == eval.StatusFailed && item.Error != "" {
			for _, detail := range strings.Split(item.Error, "\n") {
				if strings.TrimSpace(detail) != "" {
					lines = append(lines, "       "+strings.TrimSpace(detail))
				}
			}
		}
		if item.Status == eval.StatusSkipped && item.SkipReason != "" {
			lines = append(lines, "       skipped: "+item.SkipReason)
		}
	}
	lines = append(lines, report.Summary())
	if report.Failed > 0 {
		lines = append(lines, strconv.Itoa(report.Failed)+" case(s) failed")
	}
	return lines
}

func repoRootOf(start string) (string, error) {
	directory, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if info, statErr := os.Stat(filepath.Join(directory, ".git")); statErr == nil && info.IsDir() {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("no .git directory above %s", start)
		}
		directory = parent
	}
}

func main() {
	code := run(os.Args[1:], os.Stdout, os.Stderr)
	os.Exit(code)
}

func run(argv []string, stdout, stderr *os.File) int {
	options, err := parseArguments(argv)
	if err == errHelp {
		fmt.Fprint(stdout, usageText)
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "grapheval: %v\n\n%s", err, usageText)
		return 2
	}
	root, err := repoRootOf(".")
	if err != nil {
		fmt.Fprintf(stderr, "grapheval: %v\n", err)
		return 2
	}
	report := eval.Run(eval.AllCases(root), eval.Options{Layer: options.Layer, Group: options.Group, Case: options.Case})
	if options.JSON {
		payload, marshalErr := report.MarshalIndent()
		if marshalErr != nil {
			fmt.Fprintf(stderr, "grapheval: %v\n", marshalErr)
			return 2
		}
		fmt.Fprintln(stdout, string(payload))
	} else {
		for _, line := range summaryLines(report) {
			fmt.Fprintln(stdout, line)
		}
	}
	if options.Save {
		path, saveErr := saveReport(filepath.Join(root, "state"), report, time.Now)
		if saveErr != nil {
			fmt.Fprintf(stderr, "grapheval: cannot save the report: %v\n", saveErr)
			return 2
		}
		if !options.JSON {
			fmt.Fprintln(stdout, "report: "+path)
		}
	}
	return exitCode(report)
}

const usageText = `usage: grapheval [--layer e2e|integration|all] [--group main|graph|thread|rsi|sandbox] [--case name]
                 [--json] [--save|--no-save]

Runs the end-to-end and integration cases under backend/eval/cases and writes a
JSON report to state/eval/report-<timestamp>.json unless --json or --no-save.

Exit codes: 0 every selected case passed, 1 at least one failed, 2 bad usage.
`
