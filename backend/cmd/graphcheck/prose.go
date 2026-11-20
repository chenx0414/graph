package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/chenx0414/graph/backend/internal/gate"
)

const proseBaselinePath = "backend/internal/gate/testdata/prose-baseline.json"

func runProse(root string, args []string) int {
	record := hasFlag(args, "--record")
	allowance := gate.ProseAllowance{}
	if !record {
		payload, err := os.ReadFile(filepath.Join(root, proseBaselinePath))
		if err != nil {
			fmt.Fprintf(os.Stderr, "prose budget: %v\n", err)
			fmt.Fprintln(os.Stderr, "The baseline records which prose already exists; create it once:  go -C backend run ./cmd/graphcheck prose --record")
			return 2
		}
		if err := gate.ParseProseAllowance(payload, &allowance); err != nil {
			fmt.Fprintf(os.Stderr, "prose budget: %s is not readable: %v\n", proseBaselinePath, err)
			return 2
		}
	}
	found, err := gate.ScanProse(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "prose budget: %v\n", err)
		return 2
	}
	if record {
		if err := gate.WriteProseAllowance(filepath.Join(root, proseBaselinePath), found); err != nil {
			fmt.Fprintf(os.Stderr, "prose budget: %v\n", err)
			return 2
		}
		fmt.Printf("recorded %d allowed prose file(s) in %s\n", len(found), proseBaselinePath)
		return 0
	}
	problems := gate.ProseViolations(found, allowance)
	if len(problems) == 0 {
		fmt.Printf("prose budget: %d file(s), no new prose; %d still to convert\n", len(found), len(allowance.Allowed))
		return 0
	}
	for _, problem := range problems {
		fmt.Fprintf(os.Stderr, "prose budget: %s\n", problem)
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Prose is a soft dependency on the agent reading it. A rule belongs in a type, a test, a gate or a hook.")
	fmt.Fprintln(os.Stderr, "Two files carry prose on purpose: AGENTS.md (what the agent reads first) and FEATURE_MAP.md (what the code generates).")
	fmt.Fprintln(os.Stderr, "`graph:allow-prose: <reason>` exempts one file while a conversion is in flight.")
	fmt.Fprintln(os.Stderr, "Recheck with:  go -C backend run ./cmd/graphcheck prose")
	return 1
}

func sortedProse(paths []string) []string {
	out := append([]string{}, paths...)
	sort.Strings(out)
	return out
}

var _ = strings.TrimSpace
