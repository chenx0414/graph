package graph

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
// extension processes that turn is calling. The reload is not retroactive
// either - the running session keeps what it loaded, and the next session gets
// the new configuration.
func (runtime *TaskRuntime) ReloadExtensions(requestId string) map[string]any {
	runtime.ensureOpen()
	return runtime.store.Command("extensions:reload", requestId, map[string]any{"type": "reload-extensions"}, func() any {
		if inFlight := kernelRow(runtime.store.Db, `SELECT id FROM operations
        WHERE state IN ('dispatched','unknown') LIMIT 1`); inFlight != nil {
			Raise("invalid_state", "A turn is still running; reload the extension host after it settles")
		}
		running := ReloadPigExtensionHost()
		return map[string]any{"reloaded": running}
	}).(map[string]any)
}
