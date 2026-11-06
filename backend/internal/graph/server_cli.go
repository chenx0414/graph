package graph

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"bytes"
)

// RunCLI is the process the APP spawns (`dist/graphd`). It serves HTTP itself.
// It does not proxy to the TypeScript Fastify server.
func RunCLI(args []string) {
	os.Exit(runCLI(args))
}

func runCLI(args []string) (code int) {
	defer func() {
		if recovered := recover(); recovered != nil {
			code = cliFail(recovered)
		}
	}()
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	env := osEnviron()
	// The commands that are not the console: `graphd reclaim` reclaims a state
	// directory without serving anything, `graphd review-module` turns a review
	// policy into a command module, and `graphd assemble-team` builds a team
	// from a running console's capability library.
	switch {
	case len(args) > 0 && args[0] == "reclaim":
		return runReclaim(args[1:], cwd)
	case len(args) > 0 && args[0] == "review-module":
		return runReviewModule(args[1:], cwd)
	case len(args) > 0 && args[0] == "assemble-team":
		return runAssembleTeam(args[1:], cwd)
	}
	opts := parseCLI(args, env, cwd)
	if opts.help {
		fmt.Fprintln(os.Stdout, cliUsage)
		return 0
	}
	if opts.kernelDatabase != "" {
		// The kernel surfaces work on the durable namespace of a real Graph
		// database through the PiG kernel. They start no console and dispatch
		// nothing.
		if opts.kernelMode == "turn" {
			if err := PrintPigKernelTurn(opts, env); err != nil {
				return cliFail(err)
			}
			return 0
		}
		if err := PrintPigKernelReport(opts.kernelDatabase); err != nil {
			return cliFail(err)
		}
		return 0
	}
	return serveDaemon(opts, env)
}

func cliFail(recovered any) int {
	switch err := recovered.(type) {
	case *RuntimeError:
		name := err.Code
		if name == "" {
			name = "error"
		}
		fmt.Fprintf(os.Stderr, "graph: %s: %s\n", name, err.Message)
		if name == "usage" {
			return 2
		}
		return 1
	case error:
		fmt.Fprintf(os.Stderr, "graph: error: %s\n", err.Error())
		return 1
	default:
		fmt.Fprintf(os.Stderr, "graph: error: %v\n", recovered)
		return 1
	}
}

const cliUsage = `Usage: node src/server/cli.ts [options] (pnpm start [-- options])

Starts the Graph console on http://127.0.0.1 (loopback only).

Options:
  --config <path>     Config file (default: ./graph.config.json when present)
  --state-dir <path>  State directory (default: $XDG_STATE_HOME/graph or ~/.local/state/graph)
  --graph-home <path> User capability/recipe home (default: ~/.graph)
  --web-dir <path>    Built web console (default: ./dist/web)
  --port <number>     Loopback port, 0 prefers the port this state directory last served on (default: 4173)
  --execute           Enable task dispatch; requires configured models and credentials
  --dynamic           With --execute: start before credentials resolve and activate them live
  --view-only         History, settings and graph only; never dispatches (default)
  --kernel <name>     Agent kernel: pig (the Go PiG kernel, the only one)
  -h, --help          Print this help

Environment fallbacks: GRAPH_CONFIG, GRAPH_STATE_DIR, GRAPH_WEB_DIR, GRAPH_PORT.`

const firstRunConfigLine = "none — first run; add graph.config.json to enable projects and models"

type cliOptions struct {
	configPath      string
	stateDir        string
	graphHome       string
	webDir          string
	port            int
	mode            string
	dynamic         bool
	help            bool
	applicationRoot string
	// kernelDatabase asks the PiG kernel to report the durable namespace of a
	// real Graph database instead of starting the console.
	kernelDatabase string
	// kernelMode is "inspect" or "turn": what the kernel does with the database.
	kernelMode string
	// kernelModel, kernelPrompt and kernelIdentity configure a kernel turn.
	kernelModel    string
	kernelPrompt   string
	kernelIdentity string
	// kernelMcp is a JSON file with the MCP servers a kernel turn connects.
	kernelMcp string
}

func parseCLI(argv []string, env map[string]string, cwd string) cliOptions {
	var configFlag, stateFlag, homeFlag, webFlag, portFlag, rootFlag, kernelFlag, kernelModelFlag, kernelPromptFlag, kernelIdentityFlag, kernelMcpFlag string
	agentKernelFlag := ""
	kernelMode := ""
	configSet, stateSet, homeSet, webSet, portSet, rootSet := false, false, false, false, false, false
	execute, dynamic, viewOnly, help := false, false, false, false
	for index := 0; index < len(argv); index++ {
		arg := argv[index]
		value := func() string {
			if index+1 >= len(argv) || strings.HasPrefix(argv[index+1], "--") {
				Raise("usage", arg+" requires a value")
			}
			index++
			return argv[index]
		}
		switch arg {
		case "--config":
			configFlag, configSet = value(), true
		case "--state-dir":
			stateFlag, stateSet = value(), true
		case "--graph-home":
			homeFlag, homeSet = value(), true
		case "--web-dir":
			webFlag, webSet = value(), true
		case "--port":
			portFlag, portSet = value(), true
		case "--application-root":
			rootFlag, rootSet = value(), true
		case "--pig-kernel-inspect":
			kernelFlag = value()
			kernelMode = "inspect"
		case "--pig-kernel-turn":
			kernelFlag = value()
			kernelMode = "turn"
		case "--kernel-model":
			kernelModelFlag = value()
		case "--kernel-prompt":
			kernelPromptFlag = value()
		case "--kernel-identity":
			kernelIdentityFlag = value()
		case "--kernel-mcp":
			kernelMcpFlag = value()
		case "--kernel":
			agentKernelFlag = value()
		case "--execute":
			execute = true
		case "--dynamic":
			dynamic = true
		case "--view-only":
			viewOnly = true
		case "--help", "-h":
			help = true
		default:
			Raise("usage", "Unknown argument: "+arg)
		}
	}
	if execute && viewOnly {
		Raise("usage", "--execute and --view-only are mutually exclusive")
	}
	port := 4173
	if portSet {
		port = parsePort(portFlag)
	} else if raw, ok := env["GRAPH_PORT"]; ok {
		port = parsePort(raw)
	}
	explicit := ""
	if configSet {
		explicit = configFlag
	} else if raw, ok := env["GRAPH_CONFIG"]; ok {
		explicit = raw
	}
	configPath := ""
	if explicit != "" {
		configPath = resolvePath(cwd, explicit)
	} else {
		candidate := filepath.Join(cwd, "graph.config.json")
		if _, err := os.Stat(candidate); err == nil {
			configPath = candidate
		}
	}
	statePick := defaultStateDir(env)
	if stateSet {
		statePick = stateFlag
	} else if raw, ok := env["GRAPH_STATE_DIR"]; ok {
		statePick = raw
	}
	homePick := defaultGraphHome(env)
	if homeSet {
		homePick = homeFlag
	} else if raw, ok := env["GRAPH_HOME"]; ok {
		homePick = raw
	}
	webPick := "dist/web"
	if webSet {
		webPick = webFlag
	} else if raw, ok := env["GRAPH_WEB_DIR"]; ok {
		webPick = raw
	}
	root := cwd
	if rootSet {
		root = resolvePath(cwd, rootFlag)
	}
	kernelDatabase := ""
	if kernelFlag != "" {
		kernelDatabase = resolvePath(cwd, kernelFlag)
	}
	kernelIdentity := kernelIdentityFlag
	if kernelIdentity == "" {
		kernelIdentity = "graph-kernel-turn"
	}
	kernelMcpPath := ""
	if kernelMcpFlag != "" {
		kernelMcpPath = resolvePath(cwd, kernelMcpFlag)
	}
	mode := "view"
	if execute {
		mode = "execute"
	}
	// The PiG kernel is the only kernel. The TypeScript durable sidecar is
	// retired with the protocol layer that carried it, so the flag stays only
	// to tell an operator who still asks for the old kernel why it is gone.
	switch agentKernelFlag {
	case "", AgentKernelPig:
	case "node":
		Raise("usage", "the TypeScript durable sidecar is retired: the PiG kernel is the only kernel, and --kernel node is no longer available")
	default:
		Raise("usage", "--kernel must be "+AgentKernelPig)
	}
	return cliOptions{
		configPath:      configPath,
		stateDir:        resolvePath(cwd, statePick),
		graphHome:       resolvePath(cwd, homePick),
		webDir:          resolvePath(cwd, webPick),
		port:            port,
		mode:            mode,
		dynamic:         dynamic,
		help:            help,
		applicationRoot: root,
		kernelDatabase:  kernelDatabase,
		kernelMode:      kernelMode,
		kernelModel:     kernelModelFlag,
		kernelPrompt:    kernelPromptFlag,
		kernelIdentity:  kernelIdentity,
		kernelMcp:       kernelMcpPath,
	}
}

func parsePort(raw string) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		// Number('') is 0 in the TypeScript CLI.
		return 0
	}
	n, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || n < 0 || n > 65535 {
		Raise("usage", "Invalid port: "+raw)
	}
	return int(n)
}

func resolvePath(cwd, p string) string {
	if p == "" {
		return cwd
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(cwd, p))
}

func defaultStateDir(env map[string]string) string {
	home := strings.TrimSpace(env["HOME"])
	if home == "" {
		dir, err := os.UserHomeDir()
		if err != nil {
			panic(err)
		}
		home = dir
	}
	base := strings.TrimSpace(env["XDG_STATE_HOME"])
	if base == "" {
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "graph")
}

func defaultGraphHome(env map[string]string) string {
	if raw, ok := env["GRAPH_HOME"]; ok && strings.TrimSpace(raw) != "" {
		return raw
	}
	dir, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}
	return filepath.Join(dir, ".graph")
}

func osEnviron() map[string]string {
	out := map[string]string{}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			out[key] = value
		}
	}
	return out
}

// daemonGraphHome is the capability/recipe directory from --graph-home.
// Catalog loading reads it when that port attaches.
var daemonGraphHome string

type errorJSON struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

// serveDaemon starts the console with the full route table and waits for a stop
// signal. The TypeScript cli.ts starts the same daemon through startGraphDaemon;
// this is the Go equivalent, so the served surface is the complete app.
func serveDaemon(opts cliOptions, env map[string]string) int {
	ApplicationRoot = opts.applicationRoot
	daemonGraphHome = opts.graphHome
	log := func(line string) { fmt.Fprintln(os.Stdout, line) }
	var configPath *string
	if opts.configPath != "" {
		value := opts.configPath
		configPath = &value
	}
	daemon := StartGraphDaemon(DaemonOptions{
		ConfigPath: configPath, StateDir: opts.stateDir, WebDir: opts.webDir, GraphHome: opts.graphHome,
		Port: opts.port, Mode: opts.mode, Env: env, Log: log, Dynamic: opts.dynamic,
	})
	configLine := firstRunConfigLine
	if daemon.ConfigPath != nil {
		configLine = *daemon.ConfigPath
	}
	printBanner(daemon.Mode, configLine, daemon.StateDir, daemon.WebDir, daemon.ModelCount, daemon.EnabledModelCount, daemon.URL)
	_ = os.Stdout.Sync()
	// Publish the bound address: with `--port 0` (what the desktop app passes) this is the only
	// place the console URL exists, and it is also how the next start returns to the same port.
	// A stop deliberately leaves it in place.
	WriteConsoleAddress(daemon.StateDir, ConsoleAddress{
		URL: daemon.URL, PID: os.Getpid(), Mode: daemon.Mode, StartedAt: NowMillis(),
	})
	_ = os.Chmod(ConsoleAddressPath(daemon.StateDir), 0o600)
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	return stopGraphDaemon(daemon, signals, <-signals)
}

func printBanner(mode, configLine, stateDir, webDir string, modelCount, enabled int, url string) {
	modeLine := "view-only (history, settings and graph; no model dispatch)"
	if mode == "execute" {
		modeLine = "execute (task dispatch enabled)"
	}
	lines := []string{
		"Graph console",
		"  mode:      " + modeLine,
		"  config:    " + configLine,
		"  state:     " + stateDir,
		"  web:       " + webDir,
		fmt.Sprintf("  models:    %d configured, %d enabled", modelCount, enabled),
		"  address:   " + url,
		"  stop:      Ctrl-C / SIGTERM (bounded 5s stop)",
		"The browser is only a client; closing it does not stop the daemon.",
	}
	for _, line := range lines {
		fmt.Println(line)
	}
}

func stopGraphDaemon(daemon *GraphDaemon, signals <-chan os.Signal, sig os.Signal) int {
	fmt.Printf("%s received; stopping with a 5s deadline...\n", signalName(sig))
	_ = os.Stdout.Sync()
	done := make(chan struct{})
	go func() {
		daemon.Close()
		close(done)
	}()
	select {
	case <-done:
		return 0
	case next := <-signals:
		fmt.Fprintf(os.Stderr, "graph: Second %s; exiting immediately.\n", signalName(next))
		return 1
	case <-time.After(5 * time.Second):
		fmt.Fprintf(os.Stderr, "graph: Stop deadline exceeded; exiting with code 1. In-flight work stays recorded and is re-verified on restart.\n")
		return 1
	}
}

func signalName(sig os.Signal) string {
	if sig == syscall.SIGINT {
		return "SIGINT"
	}
	return "SIGTERM"
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		panic(err)
	}
	raw := bytes.TrimRight(buf.Bytes(), "\n")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func writePublic(w http.ResponseWriter, recovered any) {
	status, code, message, field := PublicError(recovered)
	writeJSON(w, status, errorJSON{Code: code, Message: message, Field: field})
}

var configFieldPattern = regexp.MustCompile(`^[A-Za-z0-9_$.\[\]-]+`)
