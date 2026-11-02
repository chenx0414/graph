package graph

import (
	"errors"
	"fmt"

	"github.com/chenx0414/graph/backend/internal/pigkernel"

	"os"
	"path/filepath"
	"strings"
	"sync"

	"context"

	"github.com/MichaelKinsy/PiG/ai"

	"time"
)

// pigExtensionHosts are the resident hosts of the daemon's Pi extensions, one
// per workspace.
//
// The Node process of an extension is expensive to start and worth keeping, so
// an extension is loaded once per workspace no matter how many sessions bind it.
//
// One host per workspace, not one per daemon, because the host's cwd *is* the
// extension's cwd: a search, a write or a spawned browser resolves a relative
// path against it. A single host handed every session the same scratch
// directory, so an extension that searches its cwd searched `~/.graph/tmp` and
// never found the project - measured 2026-11-02, right after the same host
// learned to emit session_start and pi-fff started answering (it returned a
// patch file from the scratch dir instead of the repository).
//
// They are replaceable on purpose. Measured 2026-11-01: an extension reads its
// own configuration when the host starts, so a server installed while the daemon
// was running stayed invisible - not only in the running session, but in every new
// conversation too, and a capability refresh did not help either. Only a new
// host reads the configuration again, so "reload" means "start new hosts", not
// "restart the app".
var pigExtensionHostState = &pigExtensionHosts{}

type pigExtensionHosts struct {
	// lifecycle is held shared while one load runs and exclusively while the
	// hosts are replaced, so a reload cannot close a host under a load.
	lifecycle sync.RWMutex
	mu        sync.Mutex
	hosts     map[string]*pigkernel.ExtensionHost
}

// acquire returns the host serving one workspace and the release of the read
// lock that keeps it alive for the load.
func (hosts *pigExtensionHosts) acquire(workspace string) (*pigkernel.ExtensionHost, func()) {
	hosts.lifecycle.RLock()
	cwd := pigExtensionHostCwd(workspace)
	hosts.mu.Lock()
	if hosts.hosts == nil {
		hosts.hosts = map[string]*pigkernel.ExtensionHost{}
	}
	host := hosts.hosts[cwd]
	if host == nil {
		host = pigkernel.NewExtensionHost(cwd)
		hosts.hosts[cwd] = host
	}
	hosts.mu.Unlock()
	return host, hosts.lifecycle.RUnlock
}

// take removes every host, so the caller can close them outside the locks.
func (hosts *pigExtensionHosts) take() []*pigkernel.ExtensionHost {
	hosts.lifecycle.Lock()
	defer hosts.lifecycle.Unlock()
	hosts.mu.Lock()
	taken := hosts.hosts
	hosts.hosts = nil
	hosts.mu.Unlock()
	closed := make([]*pigkernel.ExtensionHost, 0, len(taken))
	for _, host := range taken {
		closed = append(closed, host)
	}
	return closed
}

// withPigExtensionHost runs one extension load against the host of its
// workspace, and holds the read lock so a reload cannot close it underneath.
func withPigExtensionHost(workspace string, run func(host *pigkernel.ExtensionHost) error) error {
	host, release := pigExtensionHostState.acquire(workspace)
	defer release()
	return run(host)
}

// withExisting reaches the host of one workspace without creating one.
//
// Emitting an event must never be the reason an extension process starts: a
// node that binds no extension has no host, and a session that never bound one
// has nothing to tell it.
func (hosts *pigExtensionHosts) withExisting(workspace string, run func(host *pigkernel.ExtensionHost)) bool {
	hosts.lifecycle.RLock()
	defer hosts.lifecycle.RUnlock()
	hosts.mu.Lock()
	host := hosts.hosts[pigExtensionHostCwd(workspace)]
	hosts.mu.Unlock()
	if host == nil {
		return false
	}
	run(host)
	return true
}

// pigExtensionTurnStarted tells the extensions of one workspace that a turn is
// about to run, with the prompt it answers.
//
// before_agent_start is where a Pi extension injects context, narrows the tool
// list or prepares per-turn state. It is the per-turn half of the contract whose
// session half is session_start; a host that sends only the first leaves an
// extension initialized but never told what the turn is about.
func pigExtensionTurnStarted(workspace, prompt string) []error {
	failures := []error{}
	pigExtensionHostState.withExisting(workspace, func(host *pigkernel.ExtensionHost) {
		failures = host.EmitBeforeAgentStart(prompt)
	})
	return failures
}

// pigExtensionTurnStart emits before_agent_start for one turn and files a
// failure as an event instead of failing the turn.
//
// An extension that cannot prepare a turn is the extension's problem: its tools
// will say so when they run, and a turn that never asked the model anything
// would be the worse answer.
func pigExtensionTurnStart(store *TaskStore, taskId, operationId, nodeId, workspace, prompt string) {
	failures := pigExtensionTurnStarted(workspace, prompt)
	if len(failures) == 0 || store == nil {
		return
	}
	messages := []string{}
	for _, failure := range failures {
		messages = append(messages, failure.Error())
	}
	func() {
		defer func() { _ = recover() }()
		store.Event(taskId, "pi.extension.before_agent_start_failed", map[string]any{
			"operationId": operationId, "nodeId": nodeId, "message": strings.Join(messages, "; "),
		})
	}()
}

// raisePiExtensionLoadErrors refuses a session whose bound extension did not
// load, naming the extension that failed.
func raisePiExtensionLoadErrors(errors []AgentSessionExtensionError) {
	if len(errors) == 0 {
		return
	}
	details := []string{}
	for _, item := range errors {
		details = append(details, fmt.Sprintf("%s: %v", item.Path, item.Error))
	}
	Raise("capability_unavailable", "A bound Pi extension failed to load: "+strings.Join(details, "; "))
}

// pigExtensionHostCwd is the directory an extension process works in.
//
// An extension resolves a relative path against its own process cwd, and the
// host passes that cwd straight to the child (`cmd.Dir`). Empty handed, the
// child inherited the daemon's cwd - `/` when the app is launched from Finder -
// so a relative screenshot or artifact path failed with "Permission denied" and
// the whole verification was reported as broken. The session's own work copy is
// the answer whenever there is one; the scratch directory is the fallback.
func pigExtensionHostCwd(workspace string) string {
	if trimmed := strings.TrimSpace(workspace); trimmed != "" {
		if info, err := os.Stat(trimmed); err == nil && info.IsDir() {
			return filepath.Clean(trimmed)
		}
	}
	return pigExtensionScratchDir()
}

// ReloadPigExtensionHost closes the daemon's extension host, so the next session
// starts a new one and every extension reads its configuration again. It reports
// whether a host was actually running.
func ReloadPigExtensionHost() bool {
	hosts := pigExtensionHostState.take()
	if len(hosts) == 0 {
		return false
	}
	for _, host := range hosts {
		host.Close()
	}
	return true
}

// pigExtensionScratchDir is the directory an extension process works in.
func pigExtensionScratchDir() string {
	dir := filepath.Join(GraphHome(), "tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return GraphHome()
	}
	return dir
}

// ClosePigExtensions stops the extension processes the daemon started.
//
// It never starts a host only to close it: a daemon that never loaded an
// extension has nothing to stop.
func ClosePigExtensions() {
	for _, host := range pigExtensionHostState.take() {
		host.Close()
	}
}

// pigExtensionSpecs returns the tools the session's Pi extensions register.
//
// The extension is the authority: it declares the tool and its schema. The
// capability is the contract: it declares the tools of the extension the
// session may see, and the session's own policy says which of them the model
// may call. A tool the capability did not declare is not the session's tool
// at all.
func pigExtensionSpecs(ctx context.Context, request AgentSessionRequest, broker SendGate, record func(tool string, ms float64, isError bool)) ([]pigkernel.ToolSpec, error) {
	specs := []pigkernel.ToolSpec{}
	if len(request.PiExtensionPaths) == 0 {
		return specs, nil
	}
	if !request.ExtensionProcessAllowed {
		return nil, piExtensionRefusal{reason: "the session's policy is narrower than the daemon's own reach, and a Pi extension runs in a process with that reach"}
	}
	declared := map[string]bool{}
	for _, name := range request.PiExtensionTools {
		declared[name] = true
	}
	allowed := map[string]bool{}
	for _, name := range request.AllowedToolNames {
		allowed[name] = true
	}
	for _, path := range request.PiExtensionPaths {
		extensionPath := path
		var extensionSpecs []pigkernel.ToolSpec
		err := withPigExtensionHost(request.Workspace, func(host *pigkernel.ExtensionHost) error {
			loaded, err := host.Load(ctx, extensionPath)
			if err != nil {
				return err
			}
			// A Pi extension builds its state on session_start, and the host
			// serves every session of the daemon: the event is emitted once per
			// extension per host, right after the load that made it available and
			// before any of its tools is called. Without it a stateful extension
			// answers from a state nobody built - measured 2026-11-02: pi-fff
			// rejected every search with "FFF picker factory is not initialized".
			for _, failure := range host.EmitSessionStart("startup") {
				if request.OnEvent != nil {
					request.OnEvent(map[string]any{
						"type":    "pi_extension_setup_failed",
						"message": failure.Error(),
					})
				}
			}
			for _, tool := range loaded.Tools() {
				if !declared[tool.Name] {
					continue
				}
				if len(allowed) > 0 && !allowed[tool.Name] {
					continue
				}
				extensionSpecs = append(extensionSpecs, pigExtensionToolSpec(loaded, tool, broker, record))
			}
			return nil
		})
		if err != nil {
			return nil, piExtensionRefusal{reason: err.Error()}
		}
		specs = append(specs, extensionSpecs...)
	}
	return specs, nil
}

// pigExtensionToolSpec is one extension tool, as the kernel sees it.
//
// The call goes through the same gate as every other tool: the gate admits
// the call, the extension's own hook may still refuse it, and the extension
// runs the body in its own process.
func pigExtensionToolSpec(loaded *pigkernel.LoadedExtension, tool pigkernel.ExtensionTool, broker SendGate, record func(tool string, ms float64, isError bool)) pigkernel.ToolSpec {
	return pigkernel.ToolSpec{
		Name:        tool.Name,
		Description: tool.Description,
		Parameters:  tool.Parameters,
		Result: func(ctx context.Context, args map[string]any) (any, error) {
			// The definition is built per call so the turn's context reaches
			// the extension: the call belongs to this turn, and a turn that
			// ends must not leave a call running in the extension's process.
			definition := ToolDefinition{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.Parameters,
				Execute: func(toolCallID string, params any) (any, error) {
					return pigExtensionCall(ctx, loaded, tool, toolCallID, params)
				},
			}
			gated := piWorkerGatedTool(definition, broker)
			started := time.Now()
			value := gated(graphUUID(), args, ctx)
			failure, failed := value.(error)
			// An extension tool is telemetry like any other tool: without this row
			// nobody can say afterwards which Agent called agent_browser.
			if record != nil {
				record(tool.Name, float64(time.Since(started).Milliseconds()), failed)
			}
			if failed {
				return nil, failure
			}
			return value, nil
		},
	}
}

// pigExtensionCall runs one extension tool call.
//
// The extension's own hook comes first: it may refuse the call, and it may
// edit the arguments the tool receives. The tool then runs in the extension's
// process, and the extension's result hook may still rewrite what the model
// reads.
func pigExtensionCall(ctx context.Context, loaded *pigkernel.LoadedExtension, tool pigkernel.ExtensionTool, toolCallID string, params any) (any, error) {
	arguments, _ := params.(map[string]any)
	if arguments == nil {
		arguments = map[string]any{}
	}
	verdict, err := loaded.BeforeToolCall(ctx, tool.Name, toolCallID, arguments)
	if err != nil {
		return pigExtensionFailure("the Pi extension could not be asked about the call: " + err.Error()), nil
	}
	if verdict.Block {
		reason := verdict.Reason
		if reason == "" {
			reason = "the Pi extension refused the call"
		}
		return pigExtensionText("The Pi extension refused the call: " + reason), nil
	}
	value, err := tool.Execute(ctx, toolCallID, arguments)
	if err != nil {
		return pigExtensionFailure("the Pi extension failed: " + err.Error()), nil
	}
	result := pigkernel.ExtensionResultOf(value)
	patched, err := loaded.AfterToolResult(ctx, tool.Name, toolCallID, arguments, result)
	if err != nil {
		return pigExtensionFailure("the Pi extension could not be shown the result: " + err.Error()), nil
	}
	return patched, nil
}

// pigExtensionText is a tool result that carries one line of text.
func pigExtensionText(text string) ai.ToolResultMessage {
	return ai.ToolResultMessage{
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
	}
}

// pigExtensionFailure is a tool result that says the call failed.
//
// The failure is the extension's own: the model has to be able to tell a
// refusal from an answer, and a failed call is neither.
func pigExtensionFailure(text string) ai.ToolResultMessage {
	return ai.ToolResultMessage{
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
		IsError: true,
	}
}

// pigExtensionProcessAllowed says whether a session's policy is as wide as
// the daemon's own reach.
//
// The extension's process has the daemon's reach: it reads and writes the
// host and reaches the network. A session that may not do that itself may
// not host an extension either, because the extension would do it for the
// session. The default policy is full access, so a session that never asked
// for a narrower one may host an extension.
func pigExtensionProcessAllowed(policy *ResolvedAccessPolicy) bool {
	if policy == nil {
		return true
	}
	return IsHostRead(policy) && IsHostWrite(policy) && policy.Network == "unrestricted"
}

// nodeAccessPolicy is the access policy one node session runs under.
func nodeAccessPolicy(session NodeSession) *ResolvedAccessPolicy {
	if session.Environment == nil {
		return nil
	}
	return session.Environment.Access
}

// errPiExtensionNotHosted is the refusal a session gets when a bound Pi
// extension cannot be hosted for it.
var errPiExtensionNotHosted = errors.New("a bound Pi extension could not be hosted")

// piExtensionRefusal says why a bound Pi extension could not be hosted.
type piExtensionRefusal struct {
	reason string
}

func (refusal piExtensionRefusal) Error() string { return refusal.reason }

func (refusal piExtensionRefusal) Unwrap() error { return errPiExtensionNotHosted }
