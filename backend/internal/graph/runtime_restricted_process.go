package graph

import (
	"fmt"
	"sync"
)

// RestrictedGate is the gate the restricted executor charges model traffic
// through: the same dispatch/settle shape as the call broker's own gate.
//
// The TypeScript source declares two interfaces with identical members
// (SendGate in controlled-openai.ts and RestrictedGate here). Go has one
// package, so the two names carry one shape.
type RestrictedGate = SendGate

// RestrictedProcessControl is the trusted host's view of a spawned restricted
// process. Worker-supplied paths must never populate this interface.
type RestrictedProcessControl struct {
	// Pid is the process-group leader the host spawned.
	Pid *int
	// Write sends one JSON message to the process' stdin.
	Write func(message any) bool
	// End closes the process' stdin.
	End func()
	// Kill signals the process group.
	Kill func(signal string) bool
}

// RestrictedCommand is one restricted process invocation.
type RestrictedCommand struct {
	// Broker admits the invocation and settles its usage.
	Broker RestrictedGate
	// Cwd is the working directory of the process.
	Cwd string
	// ScratchDir is the writable scratch root of the process.
	ScratchDir string
	// Executable is the program to run.
	Executable string
	// Args are the arguments of the program.
	Args []string
	// Input is written to the process' stdin.
	Input string
	// ReadPaths are the roots the process may read.
	ReadPaths []string
	// WritePaths are the roots the process may write.
	WritePaths []string
	// Filesystem is "bounded" (default) or "host".
	Filesystem string
	// Unsandboxed runs the command without a seatbelt profile. A full-access
	// process is the user's own command: a profile denies window-server and
	// pasteboard mach lookups and forbids nesting /usr/bin/sandbox-exec,
	// which silently breaks exactly what full access promised.
	Unsandboxed bool
	// ProtectedPaths are denied for both read and write in host filesystem mode.
	ProtectedPaths []string
	// ProtectedPathExceptions stay readable and writable inside an otherwise
	// protected root.
	ProtectedPathExceptions []string
	// ProtectedReadPathExceptions stay readable, but not writable, inside an
	// otherwise protected root.
	ProtectedReadPathExceptions []string
	// DenyWrite are paths the process may not write.
	DenyWrite []string
	// AllowGitMetadataWrites are caches that may contain their own VCS metadata.
	AllowGitMetadataWrites []string
	// GitMetadataWritesInsideScratch lets a host-mode command write Git
	// metadata inside its own scratch directory while every repository
	// outside it stays protected.
	GitMetadataWritesInsideScratch bool
	// AllowGitMetadataWritesAll is the high-risk switch that allows host Git
	// metadata writes.
	AllowGitMetadataWritesAll bool
	// TimeoutMs bounds the run. Zero means no limit.
	TimeoutMs int
	// OnRequest answers a worker request that arrives on the channel.
	OnRequest func(request any) (any, error)
	// OnWorkerMessage receives resident protocol notifications; replies travel
	// over host-controlled stdin.
	OnWorkerMessage func(message any)
	// LocalNetwork lets a confirmed program check bind and reach loopback.
	LocalNetwork bool
	// NetworkDomains is the outbound allowlist of the restricted process.
	NetworkDomains []string
	// AllowUnrestrictedNetwork is the explicit browser-MCP mode; network
	// remains mediated by the sandbox proxy.
	AllowUnrestrictedNetwork bool
	// AllowLocalBinding allows loopback listeners and connectors for local
	// browser daemons and Chrome CDP.
	AllowLocalBinding bool
	// UnixSockets are the explicit Unix socket roots for local capability
	// daemons.
	UnixSockets []string
	// AllowAllUnixSockets lets a host-mode command use every AF_UNIX endpoint.
	AllowAllUnixSockets bool
	// AllowAppleEvents is the high-risk macOS integration; it launches code
	// outside the sandbox.
	AllowAppleEvents bool
	// Env is the host-selected environment; worker input must never populate
	// this.
	Env map[string]string
	// KeepStdinOpen keeps stdin open so the trusted host can steer a
	// long-running worker.
	KeepStdinOpen bool
	// Signal cancels this command and its process tree.
	Signal *AbortSignal
	// OnSpawn exposes only the process control surface the trusted host needs.
	OnSpawn func(control McpProcessControl)
	// OnProcess exposes the full process control surface of the spawn, with
	// the pid and the stdin writer the resident protocol needs.
	OnProcess func(control RestrictedProcessControl)
	// OnStdout is the trusted host callback for streamed stdout; restricted
	// workers cannot set it.
	OnStdout func(chunk string)
	// OnCancel handles an out-of-band worker cancellation without waiting
	// behind long requests.
	OnCancel func(request any)
	// Preflight runs before the process is created; a preflighted command
	// creates no ledger invocation.
	Preflight func()
}

// RestrictedExecutor runs one command inside the verified sandbox.
type RestrictedExecutor interface {
	Run(command RestrictedCommand) CommandResult
	Close()
}

// restrictedLease is one acquired restricted executor. The trusted host owns
// the grants; worker-supplied paths must never populate this interface.
type restrictedLease struct {
	Executor interface {
		Run(RestrictedCommand) CommandResult
	}
	Release func()
}

// RestrictedMcpExecutor adapts the shared executor to the MCP client's
// narrower reply type. Both replies carry the same three fields.
type RestrictedMcpExecutor struct {
	Executor interface {
		Run(RestrictedCommand) CommandResult
	}
}

// Run executes one command and answers with the MCP reply shape.
func (adapter RestrictedMcpExecutor) Run(command RestrictedCommand) McpRunResult {
	result := adapter.Executor.Run(command)
	return McpRunResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
}

var (
	restrictedExecutorMutex  sync.Mutex
	sharedRestrictedExecutor *sandboxExecutor
	sharedRestrictedRefs     int
)

// AcquireRestrictedExecutor shares one verified OS sandbox across capabilities
// and command tools; it is reset only when the last holder releases it.
func AcquireRestrictedExecutor() restrictedLease {
	restrictedExecutorMutex.Lock()
	defer restrictedExecutorMutex.Unlock()
	if sharedRestrictedExecutor == nil {
		sharedRestrictedExecutor = newSandboxExecutor()
	}
	sharedRestrictedRefs++
	acquired := sharedRestrictedExecutor
	return restrictedLease{
		Executor: acquired,
		Release: func() {
			restrictedExecutorMutex.Lock()
			defer restrictedExecutorMutex.Unlock()
			sharedRestrictedRefs--
			if sharedRestrictedRefs == 0 && sharedRestrictedExecutor == acquired {
				sharedRestrictedExecutor = nil
				acquired.Close()
			}
		},
	}
}

// OpenRestrictedExecutor prepares the verified OS sandbox this platform uses.
func OpenRestrictedExecutor() RestrictedExecutor {
	return newSandboxExecutor()
}

// EncodeWorkerReply serializes one host reply for the worker channel.
//
// The reply can carry anything a tool or a model stream produced, so it may be
// enormous or not JSON-encodable at all. Such a reply becomes a bounded
// refusal the worker can surface as an error: a reply that kills the daemon
// takes every other task down with it, which is never the better outcome.
func EncodeWorkerReply(reply any, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = maxWorkerReplyBytes
	}
	if reply == nil {
		return workerRefusal("Worker reply could not be serialized")
	}
	encoded, err := marshalJSON(reply)
	if err != nil {
		return workerRefusal("Worker reply could not be serialized: " + err.Error())
	}
	if len(encoded) > maxBytes {
		return workerRefusal(fmt.Sprintf("Worker reply exceeded %d bytes and was refused", maxBytes))
	}
	return encoded
}

// workerOkReply is one accepted worker reply.
type workerOkReply struct {
	Ok    bool `json:"ok"`
	Value any  `json:"value"`
}

// workerErrorReply is one refused worker reply.
type workerErrorReply struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error"`
}

func workerRefusal(message string) string {
	return `{"ok":false,"error":` + jsonString(message) + `}`
}
