package main

import (
	"fmt"
	"os"

	"github.com/chenx0414/graph/backend/internal/gate"
)

func runSlowTests(root string, args []string) int {
	record := hasFlag(args, "--record")
	found, err := gate.SlowTests(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slow tests: %v\n", err)
		return 2
	}
	if record {
		if err := gate.WriteSlowTestAllowance(root, found); err != nil {
			fmt.Fprintf(os.Stderr, "slow tests: %v\n", err)
			return 2
		}
		fmt.Printf("recorded %d slow test(s)\n", len(found))
		return 0
	}
	allowance, err := gate.ReadSlowTestAllowance(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slow tests: %v\n", err)
		fmt.Fprintln(os.Stderr, "Create the list once:  go -C backend run ./cmd/graphcheck slowtests --record")
		return 2
	}
	problems := gate.SlowTestViolations(found, allowance)
	if len(problems) == 0 {
		fmt.Printf("slow tests: %d test(s) skip under -short, all listed\n", len(found))
		return 0
	}
	for _, problem := range problems {
		fmt.Fprintf(os.Stderr, "slow tests: %s\n", problem)
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "The fast gate runs `go test -short` and the nightly run does not.")
	fmt.Fprintln(os.Stderr, "A test that skips under -short is only covered at night, so it has to appear in the list")
	fmt.Fprintln(os.Stderr, "at backend/internal/gate/testdata/slow-test-allowance.json.")
	fmt.Fprintln(os.Stderr, "Update it deliberately:  go -C backend run ./cmd/graphcheck slowtests --record")
	return 1
}
