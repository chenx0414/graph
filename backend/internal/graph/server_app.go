package graph

import (
	"net"
	"net/http"
	"sync"
)

const appBodyLimit = 24 * 1024 * 1024

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

func appSessionStateDir(runtime *TaskRuntime) string {
	if runtime == nil {
		return ""
	}
	return runtime.stateDir
}

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
