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
