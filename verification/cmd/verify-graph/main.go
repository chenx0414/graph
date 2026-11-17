package main

import (
	"fmt"
	"os"
	"strings"
)

const version = "0.1.0"

const usageText = `verify-graph — verification infrastructure for the Graph desktop app

Usage: verify-graph <command> [flags]

Commands:
  doctor                     Read-only checks: build, isolation, daemon, agent-desktop, user instance
  build                      Build the binaries verification runs use (daemon, cli)
  launch                     Start an isolated Graph daemon for this run
  status                     List runs under verification/.run and report orphans
  api                        Call the isolated daemon HTTP API (cookie auth is automatic)
  ui                         Drive the UI: ui render (headless), ui snapshot (live AX), ui window open|click|shot|close (real window), ui motion open|tree|press|shot|close (automation socket)
  scenario                   Run one journey file against an isolated instance
  verify                     Run journeys (--all or --journey) and write evidence
  evidence                   List or verify evidence manifests
  cover                      Build the control inventory and audit control-level coverage
  cleanup                    Stop and remove a run, or --orphans for daemons left by abandoned runs (evidence is kept)
  help                       Print this help (--json for the command table)
  version                    Print the CLI version

Flags:
  --run <id>                 Use an existing run instead of launching one
  --journey <path|id>        Journey file, or a name under verification/scenarios
  --all                      Every journey under verification/scenarios
  --lane headless|window     UI lane (default headless)
  --mode view|execute        Daemon mode for launch (default view)
  --width, --height          Headless render size (default 1440x900)
  --timeout <seconds>        Command timeout (default 120)
  --dry-run                  Print what would happen without side effects
  --orphans                  With cleanup: stop daemons under verification/.run that no live run record owns
  --older-than <seconds>     With cleanup --orphans: minimum process age before it counts as abandoned (default 120)
  --keep                     Keep the run directory after verify
  --json                     JSON output (default)

Every command prints one JSON envelope on stdout; human hints go to stderr.
Exit codes: 0 ok, 1 failed check, 2 usage, 3 environment (doctor), 4 timeout.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usageText)
		os.Exit(2)
	}
	command := os.Args[1]
	args := os.Args[2:]
	p, err := locate()
	if err != nil {
		failEnvelope(command, "", codeUsage, err.Error(), "cd into verification/ and retry").print()
		os.Exit(2)
	}
	switch command {
	case "help", "-h", "--help":
		os.Exit(helpCommand(args))
	case "version", "--version":
		os.Exit(versionCommand())
	case "doctor":
		os.Exit(doctorCommand(p, args))
	case "build":
		os.Exit(buildCommand(p, args))
	case "launch":
		os.Exit(launchCommand(p, args))
	case "status":
		os.Exit(statusCommand(p, args))
	case "api":
		os.Exit(apiCommand(p, args))
	case "ui":
		os.Exit(uiCommand(p, args))
	case "seed":
		os.Exit(seedCommand(p, args))
	case "scenario":
		os.Exit(scenarioCommand(p, args))
	case "verify":
		os.Exit(verifyCommand(p, args))
	case "evidence":
		os.Exit(evidenceCommand(p, args))
	case "cover":
		os.Exit(coverCommand(p, args))
	case "cleanup":
		os.Exit(cleanupCommand(p, args))
	default:
		failEnvelope(command, "", codeUsage, "unknown command "+command,
			"run: verify-graph help").print()
		os.Exit(2)
	}
}

type flags struct {
	values map[string]string
	lists  map[string][]string
	bools  map[string]bool
	rest   []string
}

func parseFlags(args []string, extraBoolFlags ...string) flags {
	flags := flags{values: map[string]string{}, lists: map[string][]string{}, bools: map[string]bool{}}
	bools := map[string]bool{}
	for _, flagName := range []string{"dry-run", "all", "keep", "json", "text", "quiet", "full", "attach", "seed", "rebuild", "orphans"} {
		bools[flagName] = true
	}
	for _, flagName := range extraBoolFlags {
		bools[flagName] = true
	}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			flags.rest = append(flags.rest, arg)
			continue
		}
		name := strings.TrimPrefix(arg, "--")
		if value, ok := strings.CutPrefix(name, "no-"); ok {
			flags.bools[value] = false
			continue
		}
		if bools[name] {
			flags.bools[name] = true
			continue
		}
		if index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
			flags.values[name] = args[index+1]
			flags.lists[name] = append(flags.lists[name], args[index+1])
			index++
			continue
		}
		flags.bools[name] = true
	}
	return flags
}

func (f flags) value(name, fallback string) string {
	if value, ok := f.values[name]; ok {
		return value
	}
	return fallback
}

func (f flags) number(name string, fallback int) int {
	value, ok := f.values[name]
	if !ok {
		return fallback
	}
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return fallback
	}
	return parsed
}

func (f flags) has(name string) bool { return f.bools[name] }

func (f flags) all(name string) []string { return f.lists[name] }

func helpCommand(args []string) int {
	commands := []map[string]string{
		{"name": "doctor", "summary": "read-only environment and isolation checks"},
		{"name": "build", "summary": "build graphd (and report app bundle freshness)"},
		{"name": "launch", "summary": "start an isolated daemon in verification/.run/<id>"},
		{"name": "status", "summary": "list runs, liveness, and orphan daemons"},
		{"name": "api", "summary": "GET/POST an isolated daemon endpoint"},
		{"name": "ui", "summary": "ui render <journey> (headless) | ui snapshot (live AX) | ui window (real window) | ui motion (automation socket)"},
		{"name": "scenario", "summary": "scenario run <journey file>"},
		{"name": "verify", "summary": "run journeys and write evidence"},
		{"name": "evidence", "summary": "evidence list | evidence verify <run>"},
		{"name": "cover", "summary": "cover inventory (build the control list) | cover audit (prove every control)"},
		{"name": "cleanup", "summary": "stop a run and remove its state"},
		{"name": "version", "summary": "print the CLI version"},
	}
	if parseFlags(args).has("json") {
		result := okEnvelope("help", "", map[string]any{"version": version, "commands": commands})
		return result.print()
	}
	fmt.Print(usageText)
	return 0
}

func versionCommand() int {
	return okEnvelope("version", "", map[string]any{"version": version}).print()
}
