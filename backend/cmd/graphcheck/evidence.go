package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/chenx0414/graph/backend/internal/gate"
)

func runEvidence(root string) int {
	if os.Getenv("GRAPH_UPDATE_EVIDENCE") == "1" {
		fmt.Println("Acceptance evidence updates explicitly enabled; check skipped.")
		return 0
	}
	command := exec.Command("git", "status", "--porcelain=v1", "--untracked-files=all", "--", "acceptance-evidence")
	command.Dir = root
	output, err := command.Output()
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcheck evidence: %v\n", err)
		return 2
	}
	problems := gate.EvidenceProblems(string(output))
	if len(problems) == 0 {
		fmt.Println("Acceptance evidence is unchanged.")
		return 0
	}
	return reportEvidenceProblems(problems)
}

func reportEvidenceProblems(problems []string) int {
	fmt.Fprintln(os.Stderr, "Tracked acceptance evidence changed during a normal run:")
	for _, problem := range problems {
		fmt.Fprintf(os.Stderr, "- %s\n", problem)
	}
	fmt.Fprintln(os.Stderr, "Acceptance evidence is a frozen record of what the product did; a normal run must not rewrite it.")
	fmt.Fprintln(os.Stderr, "Update it deliberately, then review the diff before committing:")
	fmt.Fprintln(os.Stderr, "  GRAPH_UPDATE_EVIDENCE=1 go -C backend test ./...")
	fmt.Fprintln(os.Stderr, "  git diff -- acceptance-evidence")
	return 1
}
