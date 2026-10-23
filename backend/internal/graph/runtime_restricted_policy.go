package graph

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

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
