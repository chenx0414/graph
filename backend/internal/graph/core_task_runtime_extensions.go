package graph

import "sync"

// deferredExtensionReload is a reload asked for while a turn was running.
//
// The guard that refuses a reload mid-turn would otherwise make the action
// unusable exactly when a person notices the problem: in this product a turn is
// running most of the time, and an Agent cannot reload the host for itself at
// all. A deferred request is applied by the drive loop as soon as nothing is in
// flight, which is the moment the reload becomes safe.
var deferredExtensionReload struct {
	mu      sync.Mutex
	pending bool
	applied int
}

func deferExtensionReload() {
	deferredExtensionReload.mu.Lock()
	defer deferredExtensionReload.mu.Unlock()
	deferredExtensionReload.pending = true
}

func takeDeferredExtensionReload() bool {
	deferredExtensionReload.mu.Lock()
	defer deferredExtensionReload.mu.Unlock()
	if !deferredExtensionReload.pending {
		return false
	}
	deferredExtensionReload.pending = false
	return true
}

func noteAppliedExtensionReload() {
	deferredExtensionReload.mu.Lock()
	defer deferredExtensionReload.mu.Unlock()
	deferredExtensionReload.applied++
}

func hasPendingExtensionReload() bool {
	deferredExtensionReload.mu.Lock()
	defer deferredExtensionReload.mu.Unlock()
	return deferredExtensionReload.pending
}

// ReloadExtensions replaces the daemon's Pi extension host, so the next session
// reads every extension's configuration again.
//
// It exists because there was no way to see a newly installed extension: the
// host is a daemon-wide singleton and an extension reads its own configuration
// when the host starts, so an MCP server installed while the app was running
// stayed invisible in every conversation, old and new, until the app restarted
// (measured 2026-11-01: a new conversation and a capability refresh both still
// showed only the server the daemon started with).
//
// A turn that is still running is left alone: closing the host would kill the
// extension processes that turn is calling. With deferred set, such a request is
// remembered and applied by ApplyDeferredExtensionReload once the daemon is
// idle instead of being refused.
func (runtime *TaskRuntime) ReloadExtensions(requestId string, deferred bool) map[string]any {
	runtime.ensureOpen()
	return runtime.store.Command("extensions:reload", requestId, map[string]any{"type": "reload-extensions", "deferred": deferred}, func() any {
		if inFlight := kernelRow(runtime.store.Db, `SELECT id FROM operations
        WHERE state IN ('dispatched','unknown') LIMIT 1`); inFlight != nil {
			if !deferred {
				Raise("invalid_state", "A turn is still running; reload the extension host after it settles")
			}
			deferExtensionReload()
			return map[string]any{"reloaded": false, "deferred": true}
		}
		running := ReloadPigExtensionHost()
		noteAppliedExtensionReload()
		return map[string]any{"reloaded": running, "deferred": false}
	}).(map[string]any)
}

// ApplyDeferredExtensionReload runs the reload that was asked for while a turn
// was running, once nothing is in flight any more. The drive loop calls it.
func (runtime *TaskRuntime) ApplyDeferredExtensionReload() {
	if !hasPendingExtensionReload() {
		return
	}
	busy := func() bool {
		return kernelRow(runtime.store.Db, `SELECT id FROM operations WHERE state IN ('dispatched','unknown') LIMIT 1`) != nil
	}
	if busy() {
		return
	}
	if !takeDeferredExtensionReload() {
		return
	}
	if busy() {
		// A turn started in the same instant: put the request back rather than
		// close the host underneath it.
		deferExtensionReload()
		return
	}
	ReloadPigExtensionHost()
	noteAppliedExtensionReload()
}

// ExtensionReloadStatus says whether a reload is waiting for an idle moment and
// how many have been applied since the daemon started.
func (runtime *TaskRuntime) ExtensionReloadStatus() map[string]any {
	deferredExtensionReload.mu.Lock()
	defer deferredExtensionReload.mu.Unlock()
	return map[string]any{"pending": deferredExtensionReload.pending, "applied": deferredExtensionReload.applied}
}
