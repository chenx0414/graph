package graph

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

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

func (executor *sandboxExecutor) Close() {
	executor.mutex.Lock()
	defer executor.mutex.Unlock()
	executor.closed = true
}

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
	systemReads := []string{"/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/dev"}
	for _, shim := range []string{"/private/var/select", "/Library/Developer/CommandLineTools"} {
		if _, err := os.Stat(shim); err == nil {
			systemReads = append(systemReads, shim)
		}
	}
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
			`(allow mach-lookup (global-name "com.apple.mDNSResponder"))`,
			`(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))`,
			"(allow system-socket (socket-domain AF_UNIX))",
			`(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))`,
			`(allow file-read* (literal "/Library/Preferences/com.apple.networkd.plist"))`,
			`(allow file-read-metadata (literal "/var"))`,
			`(allow file-read-metadata (literal "/etc"))`,
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
	launch := "exec " + commandText
	if !hostFilesystem {
		launch = "/bin/mkdir -p " + shellQuote(homeDir) + " " + shellQuote(tempDir) + " && exec " + commandText
	}
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
		options := []string{}
		if value, ok := commandEnv(command.Env, "NODE_OPTIONS"); ok && value != "" {
			options = append(options, value)
		}
		options = append(options, "--test-isolation=none", quotedNodeOption("--require="+listenGuardPath))
		environment[listenGuardEnv] = "1"
		environment["NODE_OPTIONS"] = strings.Join(options, " ")
	}
	launched := "/usr/bin/sandbox-exec"
	launchedArgs := []string{"-p", boundedProfile, "/bin/bash", "-o", "pipefail", "-c", launch}
	if command.Unsandboxed {
		launched = "/bin/bash"
		launchedArgs = []string{"-o", "pipefail", "-c", launch}
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
