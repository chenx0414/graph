package graph

import (
	"net"
	"net/http"
	"sync"
)

// appBodyLimit is the JSON body ceiling. Image attachments travel as base64
// inside a chat message, so the default 1 MiB limit would reject the very
// payloads the composer can build (up to 8 MiB of images plus text). Keep a
// bounded ceiling above that.
const appBodyLimit = 24 * 1024 * 1024

// GraphApp is the HTTP application: the route table, the session guard and the
// listener. It is the Go port of the Fastify app in src/server/app.ts.
type GraphApp struct {
	logins  *providerLogins
	runtime *TaskRuntime
	options AppOptions
	session string
	handler http.Handler
	server  *http.Server

	mutex  sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}

	layoutMutex sync.Mutex
	layouts     map[string]GraphLayout
	layoutOrder []string
}

// appSessionStateDir is the state directory the session token belongs to.
func appSessionStateDir(runtime *TaskRuntime) string {
	if runtime == nil {
		return ""
	}
	return runtime.stateDir
}

// serveProjectPrepare prepares one project for work. The console asks for it
// when the user prepares the Git baseline of a project by hand.
func (app *GraphApp) serveProjectPrepare(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	initialize, _ := body["initialize"].(bool)
	createBaseline, _ := body["createBaseline"].(bool)
	writeJSON(w, http.StatusOK, app.runtime.Prepare(TaskRuntimeProjectPrepareInput{
		ProjectId:      r.PathValue("projectId"),
		RequestId:      appBodyString(body, "requestId"),
		Initialize:     initialize,
		CreateBaseline: createBaseline,
	}))
}
