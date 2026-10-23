package graph

import (
	"path/filepath"
	"sync"
)

// withExtensionInstall serializes every npm mutation for one agent directory.
//
// Every temporary npm source shares the SDK's install root. A snapshot change can be another
// package's legitimate update, not corruption. Never remove that shared tree while resolving
// one source or refreshing catalog status. Policy, and the 2026-09-25 incident that produced it:
// docs/agent/troubleshooting.md, section 共享可变状态与安装根 (serialize by canonical path; a
// destructive action needs evidence from the affected object, never a static signal).
func withExtensionInstall[T any](agentDir string, action func() (T, error)) (T, error) {
	key := piExtensionRealpath(agentDir)
	extensionInstallsMu.Lock()
	lock := extensionInstalls[key]
	if lock == nil {
		lock = &sync.Mutex{}
		extensionInstalls[key] = lock
	}
	extensionInstallsMu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	return action()
}

// piExtensionRealpath is realpath(agentDir) with the TypeScript fallback to resolve(agentDir).
func piExtensionRealpath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return absolute
}
