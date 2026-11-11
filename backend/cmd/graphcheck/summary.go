package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/chenx0414/graph/backend/internal/sessionsummary"
)

func runSummary(arguments []string) int {
	if len(arguments) > 0 && (arguments[0] == "--help" || arguments[0] == "-h") {
		fmt.Println("usage: graphcheck summary [path to a session JSONL]")
		return 0
	}
	root, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcheck summary: %v\n", err)
		return 1
	}
	sessionsRoot := filepath.Join(root, ".codex", "sessions")
	path := ""
	if len(arguments) > 0 {
		path = arguments[0]
	} else if newest, found := sessionsummary.NewestSession(sessionsRoot); found {
		path = newest
	}
	if path == "" {
		fmt.Fprintf(os.Stderr, "No session JSONL found under %s\n", sessionsRoot)
		return 1
	}
	report, err := sessionsummary.Summarize(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcheck summary: %v\n", err)
		return 1
	}
	sessionsummary.Render(os.Stdout, report)
	return 0
}
