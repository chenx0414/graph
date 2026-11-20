package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/gate"
)

const proseBaselinePath = "backend/internal/gate/testdata/prose-baseline.json"

func runProse(root string, args []string) int {
	record := hasFlag(args, "--record")
	staged := hasFlag(args, "--staged")
	found, err := gate.ScanProse(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "prose budget: %v\n", err)
		return 2
	}
	baselinePath := filepath.Join(root, proseBaselinePath)
	allowance := gate.ProseAllowance{}
	payload, readErr := os.ReadFile(baselinePath)
	if readErr != nil {
		fmt.Fprintf(os.Stderr, "prose budget: cannot read %s: %v\n", proseBaselinePath, readErr)
		fmt.Fprintln(os.Stderr, "The baseline is checked in and only ever shrinks; restore it from git rather than generating one.")
		return 2
	}
	if err := gate.ParseProseAllowance(payload, &allowance); err != nil {
		fmt.Fprintf(os.Stderr, "prose budget: %s is not readable: %v\n", proseBaselinePath, err)
		return 2
	}
	if staged {
		return reportStagedMarkdown(root, allowance)
	}
	if record {
		return recordProseShrink(root, baselinePath, found, allowance)
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

func recordProseShrink(root, baselinePath string, found []string, allowance gate.ProseAllowance) int {
	listed := map[string]bool{}
	for _, path := range allowance.Allowed {
		listed[path] = true
	}
	added := []string{}
	for _, path := range found {
		if !listed[path] {
			added = append(added, path)
		}
	}
	if len(added) > 0 {
		for _, path := range added {
			fmt.Fprintf(os.Stderr, "prose budget: %s: recording cannot add a document\n", path)
		}
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "The baseline only shrinks: convert the rule into a type, a test, a gate or a hook, or state why this one file must stay prose.")
		fmt.Fprintln(os.Stderr, "A file that must stay prose is exempted in place:  <!-- graph:allow-prose: <reason> -->")
		fmt.Fprintln(os.Stderr, "Then re-record:  go -C backend run ./cmd/graphcheck prose --record")
		return 1
	}
	if err := gate.WriteProseAllowance(baselinePath, found); err != nil {
		fmt.Fprintf(os.Stderr, "prose budget: %v\n", err)
		return 2
	}
	fmt.Printf("recorded %d allowed prose file(s) in %s (shrunk from %d)\n", len(found), proseBaselinePath, len(allowance.Allowed))
	return 0
}

func reportStagedMarkdown(root string, allowance gate.ProseAllowance) int {
	baseline := map[string]bool{}
	for _, path := range allowance.Allowed {
		baseline[path] = true
	}
	entries, err := gate.StagedMarkdown(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "prose budget: %v\n", err)
		return 2
	}
	added := []string{}
	for _, entry := range entries {
		if !entry.Added || baseline[entry.Path] {
			continue
		}
		if allowed, _ := gate.DocumentationAllowed(entry.Path); allowed {
			continue
		}
		if exempt, _ := gate.ProseExempt(filepath.Join(root, entry.Path)); exempt {
			continue
		}
		added = append(added, entry.Path)
	}
	if len(added) == 0 {
		fmt.Println("prose budget: this change adds no markdown file")
		return 0
	}
	for _, path := range added {
		fmt.Fprintf(os.Stderr, "prose budget: %s: this change adds a markdown file\n", path)
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Markdown is a soft dependency: it only works if someone reads it. Express the rule as a type, a test, a gate or a hook.")
	fmt.Fprintln(os.Stderr, "Two documents carry prose deliberately: AGENTS.md and FEATURE_MAP.md (which is generated).")
	fmt.Fprintln(os.Stderr, "Move a still-unconverted document by editing it, not by adding a second one.")
	fmt.Fprintln(os.Stderr, "If this file genuinely must exist, say why in place:  <!-- graph:allow-prose: <reason> -->")
	_ = strings.TrimSpace
	return 1
}
