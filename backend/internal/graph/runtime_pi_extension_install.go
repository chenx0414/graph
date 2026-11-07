package graph

import (
	"path/filepath"
	"sync"
)

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
