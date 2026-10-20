package graph

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// listenGuardEnv marks the one process that owns the host's IPC channel; the
// guard clears the mark so a forked descendant never installs the shim.
const listenGuardEnv = "GRAPH_LISTEN_GUARD"

// A model turn can legitimately include large tool results and inline images.
const maxWorkerRequestBytes = 32 * 1024 * 1024
const maxWorkerReplyBytes = 32 * 1024 * 1024

// loopbackListenGuard is the preload the host installs when a confirmed check
// may bind loopback. It is the routing shim of the TypeScript implementation:
// the host owns the only listening socket of a local-network check, so the
// check's own listen call is refused unless the host grants it.
//
// TODO(port): the shim still speaks the host's Node IPC channel, so the Go
// host has to answer it over the same channel. The socket hand-off itself is
// not portable: Node's IPC protocol carries a socket descriptor as a native
// handle, and the Go host cannot mint one. The Go host therefore refuses the
// listener request instead of handing the descriptor over.
const loopbackListenGuard = `'use strict';
// Routing shim only: the sandbox denies every bind and the host owns the only
// loopback listeners. The host binds the exact requested port, duplicates the
// bound socket over the IPC channel and drops its own copy, so the check holds
// the only accepting descriptor. Removing this preload only removes the route;
// it can never grant a bind, and a busy port keeps its original error instead
// of being silently replaced by another one.
if (process.env.GRAPH_LISTEN_GUARD === '1') (function install() {
delete process.env.GRAPH_LISTEN_GUARD;
const net = require('node:net');
const dgram = require('node:dgram');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
function denied(message) {
  const error = new Error(message || 'EPERM: sandboxed checks may only listen on an explicit loopback host');
  error.code = 'EPERM';
  return error;
}
function deny() { throw denied(); }
function boundedPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}
function listenRequest(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path !== undefined || first.fd !== undefined) return undefined;
    const port = boundedPort(first.port === undefined ? 0 : first.port);
    return port === undefined ? undefined : { port, host: typeof first.host === 'string' ? first.host : undefined };
  }
  if (typeof first === 'string') return undefined; // Unix socket paths are not host-provided.
  const port = boundedPort(first === undefined ? 0 : first);
  return port === undefined ? undefined : { port, host: typeof args[1] === 'string' ? args[1] : undefined };
}
function lastCallback(args) {
  const last = args[args.length - 1];
  return typeof last === 'function' ? last : undefined;
}
function hostHandle(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof net.Server) return true;
  return typeof value.fd === 'number' && typeof value.bind === 'function' &&
    typeof value.listen === 'function' && typeof value.getsockname === 'function';
}
const listen = net.Server.prototype.listen;
const close = net.Server.prototype.close;
const waiting = new Map();
const fireOn = new Map();
const granted = new WeakMap();
const heldListening = new WeakMap();
let nextId = 1;
function holdListening(server) {
  if (heldListening.has(server)) return;
  const original = server.emit;
  const state = { original, patched: null, deferred: null };
  state.patched = function (event, ...args) {
    if (event === 'listening') {
      state.deferred = () => original.call(this, 'listening', ...args);
      return true;
    }
    return original.apply(this, [event, ...args]);
  };
  server.emit = state.patched;
  heldListening.set(server, state);
}
function releaseListening(server, fire) {
  const state = heldListening.get(server);
  if (!state) return;
  heldListening.delete(server);
  if (server.emit === state.patched) server.emit = state.original;
  if (fire && state.deferred) state.deferred();
}
function channelRef() {
  if (process.channel && typeof process.channel.ref === 'function') process.channel.ref();
}
function channelIdle() {
  if (waiting.size === 0 && fireOn.size === 0 && process.channel && typeof process.channel.unref === 'function') process.channel.unref();
}
channelIdle();
net.Server.prototype.listen = function (...args) {
  if (hostHandle(args[0])) return listen.apply(this, args);
  const request = listenRequest(args);
  if (!request || request.host === undefined || !LOOPBACK.has(request.host)) deny();
  if (typeof process.send !== 'function' || process.connected === false) deny();
  const id = nextId++;
  const callback = lastCallback(args);
  if (callback) this.once('listening', callback);
  waiting.set(id, { server: this });
  granted.set(this, id);
  channelRef();
  process.send({ type: 'graph-check-listener', id, port: request.port, host: request.host });
  return this;
};
net.Server.prototype.close = function (...args) {
  const id = granted.get(this);
  if (id !== undefined) {
    granted.delete(this);
    if (waiting.delete(id) || fireOn.delete(id)) { releaseListening(this, false); channelIdle(); }
    if (typeof process.send === 'function' && process.connected !== false) {
      try { process.send({ type: 'graph-check-listener-close', id }); } catch { /* channel closed */ }
    }
  }
  return close.apply(this, args);
};
process.on('message', (message, handle) => {
  if (!message) return;
  if (message.type === 'graph-check-listener-ready') {
    const pending = fireOn.get(message.id);
    if (!pending) { channelIdle(); return; }
    fireOn.delete(message.id);
    releaseListening(pending.server, true);
    channelIdle();
    return;
  }
  if (message.type !== 'graph-check-listener-result') return;
  const entry = waiting.get(message.id);
  if (!entry) {
    if (handle && typeof handle.close === 'function') { try { handle.close(); } catch { /* already closed */ } }
    channelIdle();
    return;
  }
  waiting.delete(message.id);
  if (message.ok && handle) {
    holdListening(entry.server);
    fireOn.set(message.id, entry);
    try { listen.call(entry.server, handle); }
    catch (error) {
      fireOn.delete(message.id);
      releaseListening(entry.server, false);
      if (handle && typeof handle.close === 'function') { try { handle.close(); } catch { /* already closed */ } }
      channelIdle();
      process.nextTick(() => { throw error; });
      return;
    }
    if (typeof process.send === 'function' && process.connected !== false) {
      process.send({ type: 'graph-check-listener-adopted', id: message.id });
    } else {
      fireOn.delete(message.id);
      releaseListening(entry.server, true);
      channelIdle();
    }
    channelIdle();
    return;
  }
  const error = new Error(message.message || 'EPERM: the host refused the loopback listener');
  error.code = message.code || 'EPERM';
  channelIdle();
  process.nextTick(() => entry.server.emit('error', error));
});
// No UDP listener is host-provided; the profile denies the bind as well.
dgram.Socket.prototype.bind = function () { deny(); };
})();
`

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

// sandboxExecutor runs commands inside the macOS seatbelt sandbox.
type sandboxExecutor struct {
	mutex  sync.Mutex
	closed bool
}

func newSandboxExecutor() *sandboxExecutor {
	if runtime.GOOS != "darwin" {
		panic(errors.New("Restricted execution has only been verified on macOS"))
	}
	return &sandboxExecutor{}
}

// Close releases the sandbox this executor owns.
func (executor *sandboxExecutor) Close() {
	executor.mutex.Lock()
	defer executor.mutex.Unlock()
	executor.closed = true
}

// Run executes one command inside the verified sandbox and returns its
// finished result.
func (executor *sandboxExecutor) Run(command RestrictedCommand) CommandResult {
	cwd := canonicalGrant(command.Cwd)
	readPaths := canonicalGrantAll(command.ReadPaths)
	writePaths := canonicalGrantAll(command.WritePaths)
	allowGitMetadataWrites := canonicalGrantAll(command.AllowGitMetadataWrites)
	unixSockets := canonicalGrantAll(command.UnixSockets)
	scratchDir := cwd
	if command.ScratchDir != "" {
		scratchDir = canonicalGrant(command.ScratchDir)
	}
	hostFilesystem := command.Filesystem == "host"
	if !hostFilesystem && !grantsScratch(writePaths, scratchDir) {
		panic(errors.New("Worker scratch directory requires a write grant"))
	}
	homeDir := filepath.Join(scratchDir, ".worker-home")
	if hostFilesystem {
		if value, ok := commandEnv(command.Env, "HOME"); ok {
			homeDir = value
		} else if value, ok := os.LookupEnv("HOME"); ok {
			homeDir = value
		}
	}
	tempDir := filepath.Join(scratchDir, ".worker-tmp")
	if hostFilesystem {
		if value, ok := os.LookupEnv("TMPDIR"); ok {
			tempDir = value
		} else {
			tempDir = "/tmp"
		}
	}
	// The macOS Git shim resolves its developer directory through
	// /private/var/select and then executes the Command Line Tools binaries.
	systemReads := []string{"/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/dev"}
	for _, shim := range []string{"/private/var/select", "/Library/Developer/CommandLineTools"} {
		if _, err := os.Stat(shim); err == nil {
			systemReads = append(systemReads, shim)
		}
	}
	// Checks may resolve loopback host names. The resolver reads /etc/hosts and
	// friends, and the profile's subpath filters only match directories.
	if _, err := os.Stat("/etc"); err == nil {
		if real, err := filepath.EvalSymlinks("/etc"); err == nil {
			systemReads = append(systemReads, real)
		}
	}
	allowedReads := []string{}
	if hostFilesystem {
		allowedReads = []string{"/"}
	} else {
		allowedReads = append(allowedReads, systemReads...)
		allowedReads = append(allowedReads, cwd, scratchDir)
		allowedReads = append(allowedReads, readPaths...)
		allowedReads = append(allowedReads, unixSockets...)
	}
	deviceWrites := []string{"/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait"}
	protectedPaths := []string{}
	if hostFilesystem {
		protectedPaths = uniquePaths(resolveAll(command.ProtectedPaths))
	}
	grantedWriteExceptions := []string{}
	grantedReadExceptions := []string{}
	if hostFilesystem {
		grantedWriteExceptions = uniquePaths(append(append([]string{}, writePaths...), scratchDir))
		grantedReadExceptions = uniquePaths(append(append([]string{}, cwd, scratchDir), append(append([]string{}, readPaths...), writePaths...)...))
		grantedReadExceptions = uniquePaths(append(grantedReadExceptions, unixSockets...))
	}
	protectedPathExceptions := []string{}
	protectedReadPathExceptions := []string{}
	if hostFilesystem {
		protectedPathExceptions = uniquePaths(append(resolveAll(command.ProtectedPathExceptions), grantedWriteExceptions...))
		protectedReadPathExceptions = uniquePaths(append(append([]string{}, protectedPathExceptions...), resolveAll(command.ProtectedReadPathExceptions)...))
		protectedReadPathExceptions = uniquePaths(append(protectedReadPathExceptions, grantedReadExceptions...))
	}
	strictProtectedReadPaths := []string{}
	strictProtectedWritePaths := []string{}
	for _, path := range protectedPaths {
		if !containsPathOrSubtree(protectedReadPathExceptions, path) {
			strictProtectedReadPaths = append(strictProtectedReadPaths, path)
		}
		if !containsPathOrSubtree(protectedPathExceptions, path) {
			strictProtectedWritePaths = append(strictProtectedWritePaths, path)
		}
	}
	// A command that opts in (every check) may write Git metadata inside its
	// own scratch directory, so the blanket regex below is replaced by denies
	// for the repositories that exist outside it: the scan skips the scratch,
	// and a deny in this sandbox always beats a later allow, so the blanket
	// form also blocked the temporary repository the check had just created.
	gitPaths := []string{}
	if hostFilesystem {
		if command.GitMetadataWritesInsideScratch {
			gitPaths = gitMetadataPaths(writePaths, scratchDir, allowGitMetadataWrites)
		}
	} else {
		gitPaths = gitMetadataPaths(writePaths, scratchDir, allowGitMetadataWrites)
	}
	profile := ""
	if hostFilesystem {
		lines := []string{"(allow file-read-metadata)"}
		if !command.AllowGitMetadataWritesAll {
			lines = append(lines, `(deny file-read* (regex #"(^|/)\.git(/|$)"))`)
			if command.GitMetadataWritesInsideScratch {
				for _, path := range gitPaths {
					lines = append(lines,
						`(deny file-write* (literal `+jsonString(path)+`))`,
						`(deny file-write* (subpath `+jsonString(path)+`))`)
				}
			} else {
				lines = append(lines, `(deny file-write* (regex #"(^|/)\.git(/|$)"))`)
			}
		}
		for _, path := range protectedPaths {
			lines = append(lines,
				`(deny file-read* (literal `+jsonString(path)+`))`,
				`(deny file-read* (subpath `+jsonString(path)+`))`,
				`(deny file-write* (literal `+jsonString(path)+`))`,
				`(deny file-write* (subpath `+jsonString(path)+`))`)
		}
		lines = append(lines, `(allow file-read* (subpath `+jsonString(cwd)+`))`)
		for _, path := range protectedReadPathExceptions {
			lines = append(lines, `(allow file-read* (subpath `+jsonString(path)+`))`)
		}
		for _, path := range protectedPathExceptions {
			lines = append(lines, `(allow file-write* (subpath `+jsonString(path)+`))`)
		}
		lines = append(lines,
			`(allow file-read* (subpath `+jsonString(scratchDir)+`))`,
			`(allow file-write* (subpath `+jsonString(scratchDir)+`))`)
		profile = strings.Join(lines, "\n")
	} else {
		profile = pinnedFilesystemProfile(allowedReads, append(append([]string{}, deviceWrites...), writePaths...), gitPaths)
	}
	// The sandbox proxy enforces one process-global allowlist. An unrestricted
	// Pi extension can live for the whole Agent turn, so it cannot hold that
	// lock without deadlocking host-side MCP calls from the same turn. Give
	// only that process a static direct-network profile instead; allowlisted
	// executions still use the serialized sandbox proxy.
	networkProfile := []string{}
	if command.AllowUnrestrictedNetwork {
		networkProfile = append(networkProfile, "(allow network-outbound)")
	}
	if command.LocalNetwork {
		networkProfile = append(networkProfile,
			`(allow network-inbound (local ip "localhost:*"))`,
			`(allow network-outbound (remote ip "localhost:*"))`,
			"(deny network-bind)")
	} else if command.AllowLocalBinding {
		networkProfile = append(networkProfile,
			`(allow network-bind (local ip "*:*"))`,
			`(allow network-inbound (local ip "*:*"))`,
			`(allow network-outbound (remote ip "localhost:*"))`)
	}
	if command.LocalNetwork || command.AllowLocalBinding {
		networkProfile = append(networkProfile,
			`(allow mach-register (global-name-regex #"^org\.chromium\."))`,
			`(allow mach-lookup (global-name-regex #"^org\.chromium\."))`,
			`(allow mach-register (global-name-regex #"^com\.google\.chrome(?:\.|$)"))`,
			`(allow mach-lookup (global-name-regex #"^com\.google\.chrome(?:\.|$)"))`,
			// macOS name resolution goes through mDNSResponder rather than a
			// plain DNS socket, so direct-network browser processes need this
			// additional lookup even when network-outbound is unrestricted.
			`(allow mach-lookup (global-name "com.apple.mDNSResponder"))`,
			`(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))`,
			"(allow system-socket (socket-domain AF_UNIX))",
			`(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))`,
			`(allow file-read* (literal "/Library/Preferences/com.apple.networkd.plist"))`,
			`(allow file-read-metadata (literal "/var"))`,
			`(allow file-read-metadata (literal "/etc"))`,
			// Chrome reads kern.hv_vmm_present during startup on macOS. The
			// sandbox otherwise denies that read and Chrome aborts.
			`(allow sysctl-read (sysctl-name "kern.hv_vmm_present"))`)
	}
	if len(unixSockets) > 0 {
		networkProfile = append(networkProfile, "(allow system-socket (socket-domain AF_UNIX))")
		for _, path := range unixSockets {
			networkProfile = append(networkProfile,
				`(allow network-bind (local unix-socket (subpath `+jsonString(path)+`)))`,
				`(allow network-outbound (remote unix-socket (subpath `+jsonString(path)+`)))`)
		}
	}
	localNetworkProfile := ""
	if len(networkProfile) > 0 {
		localNetworkProfile = "\n" + strings.Join(networkProfile, "\n")
	}
	commandText := shellQuote(command.Executable)
	for _, argument := range command.Args {
		commandText += " " + shellQuote(argument)
	}
	// Even setup writes happen after confinement. A mutable cwd must never
	// cause the host to create directories outside the original grant.
	launch := "exec " + commandText
	if !hostFilesystem {
		launch = "/bin/mkdir -p " + shellQuote(homeDir) + " " + shellQuote(tempDir) + " && exec " + commandText
	}
	// The sandbox proxy is per run, so two capabilities can never inherit one
	// another's network grant.
	proxy, proxyEnvironment := executor.openNetworkProxy(command, unixSockets)
	if proxy != nil {
		defer proxy.Close()
	}
	denyWrite := []string{"/tmp/claude", "/private/tmp/claude", filepath.Join(homeDirectory(), ".npm/_logs"), filepath.Join(homeDirectory(), ".claude/debug")}
	if hostFilesystem {
		denyWrite = append(denyWrite, strictProtectedWritePaths...)
	} else {
		denyWrite = append(denyWrite, protectedPaths...)
	}
	denyWrite = append(denyWrite, command.DenyWrite...)
	denyRead := []string{"/"}
	if hostFilesystem {
		denyRead = strictProtectedReadPaths
	}
	allowWrite := writePaths
	if hostFilesystem {
		allowWrite = []string{"/"}
	}
	base := sandboxBaseProfile(sandboxPolicy{
		denyRead:            denyRead,
		allowRead:           allowedReads,
		allowWrite:          allowWrite,
		denyWrite:           denyWrite,
		proxyPort:           proxyPort(proxy),
		allowAllUnixSockets: command.AllowAllUnixSockets,
		allowAppleEvents:    command.AllowAppleEvents,
	})
	boundedProfile := base + "\n" + profile + localNetworkProfile
	if dump := os.Getenv("GRAPH_SANDBOX_PROFILE_DUMP"); dump != "" {
		if err := os.WriteFile(dump, []byte(boundedProfile), 0o600); err != nil {
			panic(err)
		}
	}
	environment := map[string]string{
		"PATH":                filepath.Dir(command.Executable) + ":/usr/bin:/bin",
		"HOME":                homeDir,
		"TMPDIR":              tempDir,
		"LANG":                "en_US.UTF-8",
		"GIT_OPTIONAL_LOCKS":  "0",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_ATTR_NOSYSTEM":   "1",
	}
	for name, value := range command.Env {
		environment[name] = value
	}
	for name, value := range proxyEnvironment {
		environment[name] = value
	}
	var listenGuardPath string
	if command.LocalNetwork {
		listenGuardPath = filepath.Join(scratchDir, ".graph-listen-guard.cjs")
		if err := os.WriteFile(listenGuardPath, []byte(loopbackListenGuard), 0o600); err != nil {
			panic(err)
		}
		// --test-isolation=none keeps node --test files in the process that
		// owns the IPC channel; an isolation child would have no route to the
		// host.
		options := []string{}
		if value, ok := commandEnv(command.Env, "NODE_OPTIONS"); ok && value != "" {
			options = append(options, value)
		}
		options = append(options, "--test-isolation=none", quotedNodeOption("--require="+listenGuardPath))
		environment[listenGuardEnv] = "1"
		environment["NODE_OPTIONS"] = strings.Join(options, " ")
	}
	launched := "/usr/bin/sandbox-exec"
	launchedArgs := []string{"-p", boundedProfile, "/bin/sh", "-c", launch}
	if command.Unsandboxed {
		launched = "/bin/sh"
		launchedArgs = []string{"-c", launch}
	}
	invocationId := newUUID()
	result := CommandResult{}
	dispatch := func() {
		result = executor.spawnAndWait(command, launched, launchedArgs, cwd, environment, command.LocalNetwork)
	}
	if command.Preflight != nil {
		command.Preflight()
		dispatch()
	} else {
		command.Broker.Dispatch(invocationId, 0, func() any {
			dispatch()
			return nil
		})
		command.Broker.Settle(invocationId, &TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0})
	}
	return result
}

// spawnAndWait starts one restricted process and waits for its result.
func (executor *sandboxExecutor) spawnAndWait(command RestrictedCommand, launched string, launchedArgs []string, cwd string, environment map[string]string, localNetwork bool) CommandResult {
	process := exec.Command(launched, launchedArgs...)
	process.Dir = cwd
	process.Env = environmentSlice(environment)
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := process.StdinPipe()
	if err != nil {
		panic(err)
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		panic(err)
	}
	stderr, err := process.StderrPipe()
	if err != nil {
		panic(err)
	}
	// The worker channel is duplex: the child writes its notifications on it
	// and the host answers on the same channel.
	channel, channelFile, err := newDuplexChannel(process)
	if err != nil {
		panic(err)
	}
	var ipc net.Conn
	var ipcFile *os.File
	if localNetwork {
		connection, file, err := newNodeIpcChannel(process)
		if err != nil {
			panic(err)
		}
		ipc = connection
		ipcFile = file
	}
	if err := process.Start(); err != nil {
		panic(err)
	}
	// The parent's copies of the inherited descriptors are closed: a parent
	// that keeps the child's end open never sees the channel reach its end.
	_ = channelFile.Close()
	if ipcFile != nil {
		_ = ipcFile.Close()
	}
	pid := process.Process.Pid
	// The host writes the child's request on stdin, and the host may steer the
	// same stream afterwards. One lock keeps those writes from interleaving.
	var stdinMutex sync.Mutex
	writeStdin := func(payload string) bool {
		stdinMutex.Lock()
		defer stdinMutex.Unlock()
		_, err := io.WriteString(stdin, payload)
		return err == nil
	}
	control := RestrictedProcessControl{
		Pid: &pid,
		Write: func(message any) bool {
			encoded, err := marshalJSON(message)
			if err != nil {
				return false
			}
			return writeStdin(encoded + "\n")
		},
		End: func() {
			stdinMutex.Lock()
			defer stdinMutex.Unlock()
			_ = stdin.Close()
		},
		Kill: func(signal string) bool {
			return killProcessGroup(process, signal)
		},
	}
	if command.OnSpawn != nil {
		command.OnSpawn(McpProcessControl{Kill: control.Kill, End: control.End})
	}
	if command.OnProcess != nil {
		command.OnProcess(control)
	}
	var stdoutBuffer, stderrBuffer lockedBuffer
	state := &restrictedProcessState{
		process:       process,
		stdin:         stdin,
		channel:       channel,
		ipcConnection: ipc,
		stderr:        &stderrBuffer,
		command:       command,
	}
	var listener *abortListener
	if command.Signal != nil {
		listener = command.Signal.AddEventListener("abort", func() {
			state.aborted = true
			state.killTree()
		}, true)
	}
	var timer *time.Timer
	if command.TimeoutMs > 0 {
		timer = time.AfterFunc(time.Duration(command.TimeoutMs)*time.Millisecond, func() {
			state.timedOut = true
			state.killTree()
		})
	}
	var pumps sync.WaitGroup
	pumps.Add(3)
	go func() { defer pumps.Done(); stdoutBuffer.pump(stdout, command.OnStdout) }()
	go func() { defer pumps.Done(); stderrBuffer.pump(stderr, nil) }()
	go func() { defer pumps.Done(); state.readChannel(channel) }()
	if ipc != nil {
		pumps.Add(1)
		go func() { defer pumps.Done(); state.readIpc(ipc) }()
	}
	// The child reads its request from stdin. A kept-open stdin lets the host
	// steer a long-running worker, so the request is written and the stream
	// stays open; every other command ends the stream so the child sees EOF.
	// The write runs on its own goroutine: a child that never reads its stdin
	// must not block the host before the timeout reaps it.
	go func() {
		if command.Input != "" && !writeStdin(command.Input) {
			return
		}
		if !command.KeepStdinOpen {
			control.End()
		}
	}()
	waitErr := process.Wait()
	pumps.Wait()
	if timer != nil {
		timer.Stop()
	}
	if listener != nil && command.Signal != nil {
		command.Signal.RemoveEventListener(listener)
	}
	state.killTree()
	if state.aborted {
		panic(errors.New("Command aborted by user"))
	}
	result := CommandResult{
		Stdout: stdoutBuffer.String(),
		Stderr: stderrBuffer.String(),
	}
	if waitErr != nil {
		var exitError *exec.ExitError
		if errors.As(waitErr, &exitError) {
			if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				name := sandboxSignalName(status.Signal())
				if state.timedOut {
					result.Stderr += fmt.Sprintf("Process terminated by %s: it exceeded the %dms timeout\n", name, command.TimeoutMs)
				} else {
					result.Stderr += fmt.Sprintf("Process terminated by %s\n", name)
				}
			}
		} else {
			result.Stderr += waitErr.Error() + "\n"
		}
	}
	if code := process.ProcessState.ExitCode(); code >= 0 {
		value := code
		result.Code = &value
	}
	return result
}

// restrictedProcessState is the mutable state of one running process.
type restrictedProcessState struct {
	process       *exec.Cmd
	stdin         io.WriteCloser
	channel       net.Conn
	ipcConnection net.Conn
	stderr        *lockedBuffer
	command       RestrictedCommand
	requests      sync.Mutex
	mutex         sync.Mutex
	timedOut      bool
	aborted       bool
	pending       []byte
	bytes         int
}

// killTree reaps the whole process group of the sandbox child.
func (state *restrictedProcessState) killTree() {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	if state.process == nil || state.process.Process == nil {
		return
	}
	pid := state.process.Process.Pid
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		_ = state.process.Process.Kill()
	}
}

// readChannel reads the worker's newline-delimited protocol channel.
func (state *restrictedProcessState) readChannel(reader io.Reader) {
	buffer := make([]byte, 64*1024)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			state.mutex.Lock()
			state.pending = append(state.pending, buffer[:read]...)
			state.bytes += read
			overrun := state.bytes > maxWorkerRequestBytes
			state.mutex.Unlock()
			if overrun {
				_ = state.process.Process.Kill()
				return
			}
			for {
				state.mutex.Lock()
				index := bytes.IndexByte(state.pending, '\n')
				if index < 0 {
					state.mutex.Unlock()
					break
				}
				line := append([]byte{}, state.pending[:index]...)
				state.pending = state.pending[index+1:]
				state.bytes -= len(line) + 1
				state.mutex.Unlock()
				if !state.handleLine(line) {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// handleLine answers one worker message. It reports whether the channel
// reader may continue.
func (state *restrictedProcessState) handleLine(line []byte) bool {
	var parsed any
	if err := json.Unmarshal(line, &parsed); err != nil {
		state.appendStderr("Invalid worker request: " + err.Error() + "\n")
		state.killTree()
		return false
	}
	operation := ""
	if object, ok := parsed.(map[string]any); ok {
		operation, _ = object["operation"].(string)
	}
	if operation == "cancel" {
		if state.command.OnCancel != nil {
			state.command.OnCancel(parsed)
		}
		return true
	}
	if state.command.OnWorkerMessage != nil {
		if failed := callSafely(func() { state.command.OnWorkerMessage(parsed) }); failed != nil {
			state.appendStderr("Worker notification handling failed: " + failed.Error() + "\n")
			state.killTree()
			return false
		}
		return true
	}
	state.requests.Lock()
	defer state.requests.Unlock()
	var reply any
	if state.command.OnRequest == nil {
		reply = workerErrorReply{Ok: false, Error: "Worker requests not enabled"}
	} else {
		value, err := state.command.OnRequest(parsed)
		if err != nil {
			reply = workerErrorReply{Ok: false, Error: err.Error()}
		} else {
			reply = workerOkReply{Ok: true, Value: value}
		}
	}
	if _, err := io.WriteString(state.channel, EncodeWorkerReply(reply, maxWorkerReplyBytes)+"\n"); err != nil {
		return false
	}
	return true
}

// readIpc answers the host's Node IPC channel in local-network mode.
func (state *restrictedProcessState) readIpc(connection net.Conn) {
	reader := bufio.NewReader(connection)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			state.handleIpcLine(line)
		}
		if err != nil {
			return
		}
	}
}

// handleIpcLine answers one loopback-listener request of the check.
func (state *restrictedProcessState) handleIpcLine(line []byte) {
	var request map[string]any
	if err := json.Unmarshal(line, &request); err != nil {
		return
	}
	kind, _ := request["type"].(string)
	switch kind {
	case "graph-check-listener":
		id, ok := request["id"].(float64)
		if !ok {
			return
		}
		// TODO(port): the host binds the requested port, but Node's IPC
		// protocol carries a socket descriptor as a native handle and the Go
		// host cannot mint one. The request is refused instead of handing a
		// descriptor over.
		state.replyIpc(map[string]any{
			"type":    "graph-check-listener-result",
			"id":      int(id),
			"ok":      false,
			"code":    "EPERM",
			"message": "EPERM: the Go host cannot hand a bound listener to the check",
		})
	case "graph-check-listener-close", "graph-check-listener-adopted":
		// The host owns no descriptor for a request it refused.
	}
}

func (state *restrictedProcessState) replyIpc(payload map[string]any) {
	// The IPC connection is closed with the process; a failed write means the
	// check is gone.
	if state.ipcConnection == nil {
		return
	}
	encoded, err := marshalJSON(payload)
	if err != nil {
		return
	}
	_, _ = state.ipcConnection.Write(append([]byte(encoded), '\n'))
}

func (state *restrictedProcessState) appendStderr(text string) {
	if state.stderr == nil {
		return
	}
	state.stderr.Write(text)
}

// lockedBuffer collects one stream of a running process.
type lockedBuffer struct {
	mutex  sync.Mutex
	buffer []byte
	carry  []byte
}

// pump reads one stream and hands its decoded chunks to the host.
func (buffer *lockedBuffer) pump(reader io.Reader, onChunk func(string)) {
	chunk := make([]byte, 64*1024)
	for {
		read, err := reader.Read(chunk)
		if read > 0 {
			buffer.mutex.Lock()
			buffer.buffer = append(buffer.buffer, chunk[:read]...)
			buffer.mutex.Unlock()
			if onChunk != nil {
				buffer.carry = append(buffer.carry, chunk[:read]...)
				boundary := utf8Boundary(buffer.carry)
				text := string(buffer.carry[:boundary])
				buffer.carry = buffer.carry[boundary:]
				if text != "" {
					onChunk(text)
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// String returns everything the stream produced.
func (buffer *lockedBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return string(buffer.buffer)
}

// Write adds text the host produced to the stream.
func (buffer *lockedBuffer) Write(text string) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	buffer.buffer = append(buffer.buffer, text...)
}

// utf8Boundary returns the length of the prefix that ends on a rune boundary,
// so a multibyte character split across two reads is not decoded twice.
func utf8Boundary(data []byte) int {
	end := len(data)
	for end > 0 && !utf8.RuneStart(data[end-1]) {
		end--
	}
	if end == 0 {
		return 0
	}
	rune, size := utf8.DecodeRune(data[end-1:])
	if rune == utf8.RuneError && size == 1 && len(data)-end+1 < utf8.UTFMax {
		return end - 1
	}
	return len(data)
}

// sandboxPolicy is the sandbox profile the host builds for one command.
type sandboxPolicy struct {
	denyRead            []string
	allowRead           []string
	allowWrite          []string
	denyWrite           []string
	proxyPort           int
	allowAllUnixSockets bool
	allowAppleEvents    bool
}

// sandboxBaseProfile is the deny-default seatbelt policy the host runs every
// restricted command under.
//
// TODO(port): the TypeScript implementation delegates this part of the
// profile to the third-party sandbox runtime, whose own permission list is
// not reproduced here. The rules below are the equivalent the restricted
// command needs: process, Mach and sysctl permissions a toolchain requires,
// the filesystem grants the host asked for, and the network reach the host
// granted.
func sandboxBaseProfile(policy sandboxPolicy) string {
	lines := []string{
		"(version 1)",
		"(deny default)",
		"",
		"; Essential permissions",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow process-info* (target same-sandbox))",
		"(allow signal (target same-sandbox))",
		"(allow mach-priv-task-port (target same-sandbox))",
		"(allow user-preference-read)",
		"(allow ipc-posix-shm)",
		"(allow ipc-posix-sem)",
		"(allow iokit-get-properties)",
		"(allow iokit-open (iokit-user-client-class \"IOSurfaceSendRight\"))",
		"(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
		"(allow sysctl-read (sysctl-name-prefix \"hw.\"))",
		"(allow sysctl-read (sysctl-name-prefix \"kern.\"))",
		"(allow sysctl-read (sysctl-name-prefix \"machdep.\"))",
		"(allow sysctl-read (sysctl-name-prefix \"net.\"))",
		"(allow distributed-notification-post)",
		"(allow file-ioctl (literal \"/dev/null\"))",
		"(allow file-ioctl (literal \"/dev/zero\"))",
		"(allow file-ioctl (literal \"/dev/random\"))",
		"(allow file-ioctl (literal \"/dev/urandom\"))",
		"(allow file-ioctl (literal \"/dev/dtracehelper\"))",
		"(allow file-ioctl (literal \"/dev/tty\"))",
		"(allow mach-lookup (global-name \"com.apple.securityd.xpc\"))",
		"(allow mach-lookup (global-name \"com.apple.SecurityServer\"))",
		"(allow mach-lookup (global-name \"com.apple.coreservices.launchservicesd\"))",
		"(allow mach-lookup (global-name \"com.apple.FontObjectsServer\"))",
		"(allow mach-lookup (global-name \"com.apple.fonts\"))",
		"(allow mach-lookup (global-name \"com.apple.logd\"))",
		"(allow mach-lookup (global-name \"com.apple.lsd.mapdb\"))",
		"(allow mach-lookup (global-name \"com.apple.PowerManagement.control\"))",
		"(allow mach-lookup (global-name \"com.apple.system.logger\"))",
		"(allow mach-lookup (global-name \"com.apple.system.notification_center\"))",
		"(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))",
		"(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.membership\"))",
		"(allow mach-lookup (global-name \"com.apple.bsd.dirhelper\"))",
		"",
		"; Network",
	}
	if policy.proxyPort > 0 {
		lines = append(lines,
			"(allow network-bind (local ip \"localhost:"+itoa(policy.proxyPort)+"\"))",
			"(allow network-inbound (local ip \"localhost:"+itoa(policy.proxyPort)+"\"))",
			"(allow network-outbound (remote ip \"localhost:"+itoa(policy.proxyPort)+"\"))")
	}
	if policy.allowAllUnixSockets {
		lines = append(lines,
			"(allow system-socket (socket-domain AF_UNIX))",
			"(allow network-bind (local unix-socket (path-regex #\"^/\")))",
			"(allow network-outbound (remote unix-socket (path-regex #\"^/\")))")
	}
	if policy.allowAppleEvents {
		lines = append(lines,
			"(allow appleevent-send)",
			"(allow mach-lookup (global-name \"com.apple.coreservices.appleevents\"))",
			"(allow lsopen)",
			"(allow mach-lookup (global-name \"com.apple.CoreServices.coreservicesd\"))",
			"(allow mach-lookup (global-name \"com.apple.coreservices.quarantine-resolver\"))")
	}
	lines = append(lines, "", "; File read", "(allow file-read*)")
	for _, path := range policy.denyRead {
		lines = append(lines, "(deny file-read* (subpath "+jsonString(path)+"))")
	}
	for _, path := range policy.allowRead {
		lines = append(lines, "(allow file-read* (subpath "+jsonString(path)+"))")
	}
	if containsString(policy.denyRead, "/") {
		// (subpath "/") denies the root inode itself; dyld aborts before exec
		// when the root is not readable again.
		lines = append(lines, "(allow file-read* (literal \"/\"))")
	}
	lines = append(lines, "(allow file-read-metadata (vnode-type DIRECTORY))")
	lines = append(lines, "", "; File write")
	for _, path := range policy.allowWrite {
		lines = append(lines, "(allow file-write* (subpath "+jsonString(path)+"))")
	}
	for _, path := range policy.denyWrite {
		lines = append(lines, "(deny file-write* (subpath "+jsonString(path)+"))")
	}
	return strings.Join(lines, "\n")
}

// pinnedFilesystemProfile is the bounded filesystem policy: a path is readable
// only under a read grant and writable only under a write grant.
func pinnedFilesystemProfile(readPaths, writePaths, gitPaths []string) string {
	filters := func(paths []string) string {
		parts := make([]string, 0, len(paths))
		for _, path := range paths {
			parts = append(parts, "(subpath "+jsonString(path)+")")
		}
		return "(require-any " + strings.Join(parts, " ") + ")"
	}
	// Commands and MCP capabilities may inspect Git through the read-only
	// subcommands, but refs, the index and worktree link files stay owned by
	// the Git module. The literal filters below are built from existing
	// directories and resolved vnode paths, so a relative path cannot spell
	// around them.
	gitFilters := []string{}
	for _, path := range gitPaths {
		gitFilters = append(gitFilters, "(literal "+jsonString(path)+")", "(subpath "+jsonString(path)+")")
	}
	// Intersect the sandbox with literal, already-approved paths. The sandbox
	// normalizes paths again while building its profile; that must not turn a
	// concurrent symlink replacement into a grant to a different directory.
	return "(deny file-read* (require-not (require-any (literal \"/\") " + filters(readPaths) + ")))\n" +
		"    (allow file-read-metadata (vnode-type DIRECTORY))\n" +
		"    (deny file-write* (require-not " + filters(writePaths) + "))\n" +
		"    " + strings.Join(gitFilters, " ")
}

// gitMetadataPaths returns every existing Git metadata entry under the write
// grants, without following symlinks.
func gitMetadataPaths(roots []string, scratchDir string, allowGitMetadataWrites []string) []string {
	insideScratch := func(path string) bool {
		return path == scratchDir || strings.HasPrefix(path, scratchDir+"/")
	}
	insideAllowedCache := func(path string) bool {
		for _, root := range allowGitMetadataWrites {
			if path == root || strings.HasPrefix(path, root+"/") {
				return true
			}
		}
		return false
	}
	found := []string{}
	seen := map[string]bool{}
	entriesSeen := 0
	for _, root := range roots {
		covered := false
		for _, other := range roots {
			if other != root && strings.HasPrefix(root, other+"/") {
				// A parent grant covers this root.
				covered = true
				break
			}
		}
		if covered {
			continue
		}
		stack := []string{root}
		for len(stack) > 0 {
			dir := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if insideScratch(dir) {
				continue
			}
			if insideAllowedCache(dir) {
				continue
			}
			entries, err := readDirectoryEntries(dir)
			if err != nil {
				// File roots, device nodes and vanished directories have
				// nothing to scan.
				continue
			}
			entriesSeen += len(entries)
			if entriesSeen > 50_000 {
				panic(errors.New("Workspace is too large to verify the Git metadata boundary"))
			}
			for _, entry := range entries {
				path := filepath.Join(dir, entry.Name())
				if entry.Name() == ".git" {
					if !seen[path] {
						seen[path] = true
						found = append(found, path)
					}
					continue
				}
				if !entry.IsDir() || entry.Name() == "node_modules" {
					continue
				}
				stack = append(stack, path)
			}
		}
	}
	return found
}

// readDirectoryEntries lists one directory in its own order.
func readDirectoryEntries(directory string) ([]os.FileInfo, error) {
	handle, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	return handle.Readdir(-1)
}

// networkProxy is the loopback HTTP proxy that enforces the domain allowlist
// of one restricted command.
type networkProxy struct {
	listener net.Listener
	domains  []string
	mutex    sync.Mutex
	closed   bool
}

// openNetworkProxy starts the proxy of one command and returns the
// environment the child needs to reach it.
func (executor *sandboxExecutor) openNetworkProxy(command RestrictedCommand, unixSockets []string) (*networkProxy, map[string]string) {
	if command.AllowUnrestrictedNetwork {
		// The static direct-network profile must not inherit the dynamic
		// proxy that belongs to another execution's allowlist.
		return nil, map[string]string{"NO_PROXY": "*", "no_proxy": "*"}
	}
	domains := command.NetworkDomains
	if command.LocalNetwork {
		domains = nil
	}
	if len(domains) == 0 && len(unixSockets) == 0 {
		return nil, map[string]string{}
	}
	proxy, err := startNetworkProxy(SandboxNetworkDomains(domains))
	if err != nil {
		panic(err)
	}
	address := "http://127.0.0.1:" + itoa(proxyPort(proxy))
	return proxy, map[string]string{
		"HTTP_PROXY":         address,
		"http_proxy":         address,
		"HTTPS_PROXY":        address,
		"https_proxy":        address,
		"ALL_PROXY":          address,
		"all_proxy":          address,
		"NO_PROXY":           "",
		"no_proxy":           "",
		"NODE_USE_ENV_PROXY": "1",
	}
}

// startNetworkProxy listens on loopback and serves the allowed domains only.
func startNetworkProxy(domains []string) (*networkProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	proxy := &networkProxy{listener: listener, domains: domains}
	go proxy.serve()
	return proxy, nil
}

// Port is the loopback port the proxy listens on.
func (proxy *networkProxy) Port() int {
	if proxy == nil || proxy.listener == nil {
		return 0
	}
	address, ok := proxy.listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0
	}
	return address.Port
}

// Close stops the proxy.
func (proxy *networkProxy) Close() {
	if proxy == nil {
		return
	}
	proxy.mutex.Lock()
	defer proxy.mutex.Unlock()
	if proxy.closed {
		return
	}
	proxy.closed = true
	_ = proxy.listener.Close()
}

func (proxy *networkProxy) serve() {
	for {
		connection, err := proxy.listener.Accept()
		if err != nil {
			return
		}
		go proxy.handle(connection)
	}
}

// handle serves one proxied request.
func (proxy *networkProxy) handle(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	request, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	if request.Method == http.MethodConnect {
		host, _, err := net.SplitHostPort(request.Host)
		if err != nil {
			return
		}
		if !AllowedDomain(proxy.domains, host) {
			return
		}
		upstream, err := net.Dial("tcp", request.Host)
		if err != nil {
			return
		}
		defer upstream.Close()
		if _, err := connection.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
			return
		}
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(upstream, connection)
			close(done)
		}()
		_, _ = io.Copy(connection, upstream)
		<-done
		return
	}
	if request.URL == nil || !request.URL.IsAbs() {
		return
	}
	if !AllowedDomain(proxy.domains, request.URL.Hostname()) {
		return
	}
	outgoing, err := http.NewRequest(request.Method, request.URL.String(), request.Body)
	if err != nil {
		return
	}
	outgoing.Header = request.Header
	client := &http.Client{Transport: &http.Transport{}}
	response, err := client.Do(outgoing)
	if err != nil {
		return
	}
	defer response.Body.Close()
	_ = response.Write(connection)
}

func proxyPort(proxy *networkProxy) int {
	if proxy == nil {
		return 0
	}
	return proxy.Port()
}

// newDuplexChannel gives one child process the duplex channel its resident
// protocol uses: the child writes its notifications on it and the host answers
// on the same channel. The child end is returned so the caller can close its
// own copy once the process started: a parent that keeps the write end open
// never sees the channel reach its end.
func newDuplexChannel(process *exec.Cmd) (net.Conn, *os.File, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, err
	}
	child := os.NewFile(uintptr(fds[0]), "graph-channel")
	parent := os.NewFile(uintptr(fds[1]), "graph-channel")
	process.ExtraFiles = append(process.ExtraFiles, child)
	connection, err := net.FileConn(parent)
	if err != nil {
		return nil, nil, err
	}
	parent.Close()
	return connection, child, nil
}

// newNodeIpcChannel gives one child process the Node IPC channel it expects.
// Node speaks newline-delimited JSON on that channel when the serialization
// mode says so, which is what the host answers in.
func newNodeIpcChannel(process *exec.Cmd) (net.Conn, *os.File, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, err
	}
	child := os.NewFile(uintptr(fds[0]), "graph-ipc")
	parent := os.NewFile(uintptr(fds[1]), "graph-ipc")
	process.ExtraFiles = append(process.ExtraFiles, child)
	process.Env = append(process.Env, "NODE_CHANNEL_FD="+itoa(3+len(process.ExtraFiles)-1), "NODE_CHANNEL_SERIALIZATION_MODE=json")
	connection, err := net.FileConn(parent)
	if err != nil {
		return nil, nil, err
	}
	parent.Close()
	return connection, child, nil
}

// killProcessGroup signals the whole process group of a sandbox child.
func killProcessGroup(process *exec.Cmd, signal string) bool {
	if process == nil || process.Process == nil {
		return false
	}
	number, ok := sandboxSignal(signal)
	if !ok {
		return false
	}
	if err := syscall.Kill(-process.Process.Pid, number); err == nil {
		return true
	}
	return process.Process.Signal(number) == nil
}

// sandboxSignal maps a signal name to its number.
func sandboxSignal(name string) (syscall.Signal, bool) {
	switch strings.ToUpper(strings.TrimPrefix(name, "SIG")) {
	case "TERM":
		return syscall.SIGTERM, true
	case "KILL":
		return syscall.SIGKILL, true
	case "INT":
		return syscall.SIGINT, true
	case "HUP":
		return syscall.SIGHUP, true
	case "QUIT":
		return syscall.SIGQUIT, true
	}
	return 0, false
}

// sandboxSignalName is the conventional name of a signal.
func sandboxSignalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	}
	return "SIG" + itoa(int(signal))
}

// callSafely runs one host callback and reports the panic it raised.
func callSafely(run func()) (failure error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if err, ok := recovered.(error); ok {
				failure = err
				return
			}
			failure = errors.New(fmt.Sprintf("%v", recovered))
		}
	}()
	run()
	return nil
}

// shellQuote quotes one word for /bin/sh.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// quotedNodeOption quotes one NODE_OPTIONS entry: the variable is
// whitespace-tokenized, so a generated option needs shell-style quoting.
func quotedNodeOption(value string) string {
	if !strings.ContainsAny(value, " \t\n\r\"\\") {
		return value
	}
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return "\"" + escaped + "\""
}

// jsonString encodes one string the way JSON.stringify does.
func jsonString(value string) string {
	encoded, err := marshalJSON(value)
	if err != nil {
		return "\"" + value + "\""
	}
	return encoded
}

// marshalJSON encodes one value without HTML escaping, like JSON.stringify.
func marshalJSON(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

// environmentSlice turns an environment map into the slice a process needs.
func environmentSlice(environment map[string]string) []string {
	entries := make([]string, 0, len(environment))
	for name, value := range environment {
		entries = append(entries, name+"="+value)
	}
	return entries
}

// commandEnv reads one name from an environment map.
func commandEnv(environment map[string]string, name string) (string, bool) {
	if environment == nil {
		return "", false
	}
	value, ok := environment[name]
	return value, ok
}

// homeDirectory is the host's home directory.
func homeDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return os.Getenv("HOME")
	}
	return home
}

// canonicalGrant resolves one granted path and refuses a path that is not
// already canonical.
func canonicalGrant(path string) string {
	requested, err := filepath.Abs(path)
	if err != nil {
		panic(err)
	}
	real, err := filepath.EvalSymlinks(requested)
	if err != nil {
		panic(err)
	}
	if real != requested || grantGlobPattern.MatchString(requested) {
		panic(errors.New("Expected an unchanged canonical grant path"))
	}
	return requested
}

// grantGlobPattern matches a path that spells a glob instead of a path.
var grantGlobPattern = regexp.MustCompile(`[*?\[\]]`)

// canonicalGrantAll resolves every granted path.
func canonicalGrantAll(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, canonicalGrant(path))
	}
	return out
}

// grantsScratch reports whether a write grant covers the scratch directory.
func grantsScratch(writePaths []string, scratchDir string) bool {
	for _, root := range writePaths {
		if scratchDir == root {
			return true
		}
		if root == "/" {
			return true
		}
		if strings.HasPrefix(scratchDir, root+"/") {
			return true
		}
	}
	return false
}

// resolveAll resolves every path against the working directory.
func resolveAll(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		resolved, err := filepath.Abs(path)
		if err != nil {
			panic(err)
		}
		out = append(out, resolved)
	}
	return out
}

// uniquePaths keeps the first spelling of every path.
func uniquePaths(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range paths {
		if seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

// containsPathOrSubtree reports whether an exception covers a protected path.
func containsPathOrSubtree(exceptions []string, path string) bool {
	for _, exception := range exceptions {
		if exception == path || strings.HasPrefix(exception, path+"/") {
			return true
		}
	}
	return false
}
