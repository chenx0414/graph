package main

import (
	"encoding/json"
	"fmt"
	"os"
)

const graphcliUsage = `graphcli - drive the Graph app as an Agent, then prove what happened

usage:
  graphcli health --address URL --token TOKEN
  graphcli open   --address URL --token TOKEN --title T --text MESSAGE
  graphcli send   --address URL --token TOKEN --conversation ID --text MESSAGE
  graphcli read   --address URL --token TOKEN --conversation ID
  graphcli shot   --address URL --token TOKEN --out FILE [--width N --height N]

Every command prints JSON on success, a message on stderr and a non-zero exit on failure, so a
shell can decide whether the evidence exists.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, graphcliUsage)
		return 2
	}
	command, rest := args[0], args[1:]
	switch command {
	case "help", "--help", "-h":
		fmt.Fprint(os.Stdout, graphcliUsage)
		return 0
	case "health":
		return runHealth(rest)
	case "open":
		return runOpen(rest)
	case "send":
		return runSend(rest)
	case "read":
		return runRead(rest)
	case "shot":
		return runShot(rest)
	}
	fmt.Fprintf(os.Stderr, "graphcli: unknown command %q\n\n%s", command, graphcliUsage)
	return 2
}

func printJSON(value any) int {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcli: %v\n", err)
		return 1
	}
	fmt.Println(string(encoded))
	return 0
}
