package main

import (
	"fmt"
	"os"

	"github.com/chenx0414/graph/backend/internal/gate"
	"github.com/chenx0414/graph/backend/statemachine"
)

func runMachines(root string, args []string) int {
	verbose := false
	for _, argument := range args {
		if argument == "--verbose" {
			verbose = true
		}
	}
	if problems := statemachine.Validate(statemachine.All()); len(problems) > 0 {
		for _, problem := range problems {
			fmt.Fprintf(os.Stderr, "[machines] registry: %s\n", problem)
		}
		return 1
	}
	evidence := gate.ScanRegistryStates(root)
	if verbose {
		for _, fact := range evidence.Facts {
			fmt.Printf("%s.%s = %s\t%s\n", fact.Table, fact.Column, fact.Value, fact.File)
		}
		for _, edge := range evidence.Edges {
			fmt.Printf("%s.%s %s -> %s\t%s\n", edge.Table, edge.Column, edge.From, edge.To, edge.File)
		}
	}
	problems := gate.CheckRegistryStates(evidence, statemachine.All())
	if len(problems) > 0 {
		return reportMachineProblems(problems)
	}
	fmt.Printf("[machines] %d machines, %d declared states, %d state literals, %d transitions across %d files\n",
		len(statemachine.All()), declaredStateCount(), len(evidence.Facts), len(evidence.Edges), evidence.Files)
	return 0
}

func reportMachineProblems(problems []gate.RegistryProblem) int {
	for _, problem := range problems {
		fmt.Fprintf(os.Stderr, "[machines] %s: %s\n", problem.Kind, problem.Detail)
	}
	fmt.Fprintf(os.Stderr, "[machines] %d problems; declare every state and transition in backend/statemachine/machines.json\n", len(problems))
	fmt.Fprintln(os.Stderr, "  The registry is the only state vocabulary; nothing else mirrors it.")
	fmt.Fprintln(os.Stderr, "  Declare a new state in its shard under backend/statemachine/machines/, then name it here in code.")
	fmt.Fprintln(os.Stderr, "  Print the whole vocabulary:  go -C backend run ./cmd/graphcheck machines --verbose")
	fmt.Fprintln(os.Stderr, "  Over HTTP, the console serves the same registry at GET /api/state-machines.")
	return 1
}

func declaredStateCount() int {
	count := 0
	for _, machine := range statemachine.All() {
		count += len(machine.States)
	}
	return count
}
