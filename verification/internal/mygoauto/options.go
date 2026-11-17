package mygoauto

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"graph/verification/internal/guard"
)

type Options struct {
	RunDir       string
	RepoRoot     string
	SourceRoot   string
	ShortID      string
	UserHome     string
	Port         int
	ReadyTimeout time.Duration
	Evidence     string
	ForceBuild   bool
}

func (o Options) withDefaults() Options {
	if o.ReadyTimeout == 0 {
		o.ReadyTimeout = 90 * time.Second
	}
	if o.SourceRoot == "" {
		o.SourceRoot = o.RepoRoot
	}
	if o.UserHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			o.UserHome = home
		}
	}
	if o.ShortID == "" {
		o.ShortID = filepath.Base(o.RunDir)
	}
	return o
}

func (o Options) appIdentityName() string { name, _ := o.appIdentity(); return name }
func (o Options) appIdentityID() string   { _, id := o.appIdentity(); return id }

func (o Options) appIdentity() (string, string) {
	short := strings.NewReplacer(".", "-", "_", "-", "/", "-").Replace(o.ShortID)
	return "GraphVerify-" + short, "dev.graph.verify." + short
}

func (o Options) appBinary() string  { return filepath.Join(o.RunDir, "bin", "graph-verify-ui") }
func (o Options) stateDir() string   { return filepath.Join(o.RunDir, "state") }
func (o Options) graphHome() string  { return filepath.Join(o.RunDir, "graph-home") }
func (o Options) homeDir() string    { return filepath.Join(o.RunDir, "home") }
func (o Options) tmpDir() string     { return filepath.Join(o.RunDir, "tmp") }
func (o Options) logsDir() string    { return filepath.Join(o.RunDir, "logs") }
func (o Options) configPath() string { return filepath.Join(o.RunDir, "graph.config.json") }
func (o Options) socketPath() string { return filepath.Join(o.RunDir, "automation.sock") }

// EvidenceDir is where proofs land. It defaults to the run directory, and the
// CLI points it at verification/evidence/<runId> so cleanup can delete the run
// without eating the proof.
func (o Options) EvidenceDir() string {
	if o.Evidence != "" {
		return o.Evidence
	}
	return filepath.Join(o.RunDir, "evidence")
}
func (o Options) stubDir() string    { return filepath.Join(o.RunDir, "bin") }
func (o Options) stubLog() string    { return o.guardPaths().ShimLog() }
func (o Options) launchAgentsDir() string {
	return filepath.Join(o.homeDir(), "Library", "LaunchAgents")
}

// guardPaths is the shared view of a run directory that internal/guard owns:
// the launchctl shadow, the sandboxed HOME and the fingerprint all follow it,
// so a window run blocked by either package is blocked the same way.
func (o Options) guardPaths() guard.Paths {
	return guard.Paths{
		Repo: o.RepoRoot, Root: o.RunDir, Home: o.homeDir(), StateDir: o.stateDir(),
		GraphHome: o.graphHome(), Config: o.configPath(), DaemonBin: o.appBinary(),
		AppName: "GraphVerify-" + o.ShortID,
	}
}

func (o Options) userLaunchAgentPlist() string {
	if o.UserHome == "" {
		return ""
	}
	return filepath.Join(o.UserHome, "Library", "LaunchAgents", "dev.graph.daemon.plist")
}

func (o Options) userConsole() string {
	if o.UserHome == "" {
		return ""
	}
	return filepath.Join(o.UserHome, "Library", "Application Support", "Graph", "state", "console.json")
}

const minimalConfig = `{"version":1,"projects":[]}` + "\n"

// prepare makes the run directory trustworthy before anything starts: an
// unwritable LaunchAgents directory and a launchctl shadow on PATH mean the
// app can never bootout the user's dev.graph.daemon (app/daemon.go returns
// early when installLaunchAgent fails).
func prepare(opts Options) error {
	for _, dir := range []string{opts.stateDir(), opts.graphHome(), filepath.Join(opts.RunDir, "build")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := os.WriteFile(opts.configPath(), []byte(minimalConfig), 0o644); err != nil {
		return err
	}
	if _, err := os.Stat(opts.configPath()); err != nil {
		return err
	}
	if err := guard.EnsureHome(opts.RunDir); err != nil {
		return fmt.Errorf("mygoauto: sandboxed HOME: %w", err)
	}
	if _, err := guard.InstallShim(opts.RunDir); err != nil {
		return fmt.Errorf("mygoauto: launchctl shadow: %w", err)
	}
	if err := os.Remove(opts.socketPath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("mygoauto: a socket left at %s cannot be replaced: %w", opts.socketPath(), err)
	}
	return nil
}

// env builds the child environment. Only the window process gets
// MYGO_AUTOMATION: the daemon is the same binary, and the automation plugin
// listens from init, so handing it the socket path would let the daemon take
// the socket and never answer on it.
func (opts Options) env(withAutomation bool) []string {
	drop := map[string]bool{"HOME": true, "TMPDIR": true, "XDG_RUNTIME_DIR": true, "MYGO_AUTOMATION": true, "GRAPH_PORT": true}
	env := []string{}
	for _, entry := range os.Environ() {
		name, _, ok := strings.Cut(entry, "=")
		if !ok || drop[name] || strings.HasPrefix(name, "GRAPH_") {
			continue
		}
		env = append(env, entry)
	}
	for _, entry := range guard.Env(opts.guardPaths(), env) {
		if strings.HasPrefix(entry, "GRAPH_PORT=") && opts.Port != 0 {
			continue
		}
		env = append(env, entry)
	}
	if opts.Port != 0 {
		env = append(env, fmt.Sprintf("GRAPH_PORT=%d", opts.Port))
	}
	env = append(env, "GRAPH_RSI_ROOT="+opts.SourceRoot, "GRAPH_DAEMON="+opts.appBinary())
	if withAutomation {
		env = append(env, "MYGO_AUTOMATION="+opts.socketPath())
	}
	return env
}
