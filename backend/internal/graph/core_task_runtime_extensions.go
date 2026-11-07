package graph

import "sync"

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

func (runtime *TaskRuntime) ReloadExtensions(requestId string, deferred bool) map[string]any {
	runtime.ensureOpen()
	return runtime.store.Command("extensions:reload", requestId, map[string]any{"type": "reload-extensions", "deferred": deferred}, func() any {
		if inFlight := kernelRow(runtime.store.Db, `SELECT id FROM operations
        WHERE state='dispatched' LIMIT 1`); inFlight != nil {
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

func (runtime *TaskRuntime) ApplyDeferredExtensionReload() {
	if !hasPendingExtensionReload() {
		return
	}
	busy := func() bool {
		return kernelRow(runtime.store.Db, `SELECT id FROM operations WHERE state='dispatched' LIMIT 1`) != nil
	}
	if busy() {
		return
	}
	if !takeDeferredExtensionReload() {
		return
	}
	if busy() {
		deferExtensionReload()
		return
	}
	ReloadPigExtensionHost()
	noteAppliedExtensionReload()
}

func (runtime *TaskRuntime) ExtensionReloadStatus() map[string]any {
	deferredExtensionReload.mu.Lock()
	defer deferredExtensionReload.mu.Unlock()
	return map[string]any{"pending": deferredExtensionReload.pending, "applied": deferredExtensionReload.applied}
}
