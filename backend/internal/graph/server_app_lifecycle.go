package graph

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// CreateApp builds the HTTP application. The runtime is the task runtime of
// src/core/task-runtime.ts; the options carry the host services the console
// reads.
func CreateApp(runtime *TaskRuntime, options AppOptions) *GraphApp {
	app := &GraphApp{
		runtime: runtime,
		options: options,
		session: LoadOrCreateSession(appSessionStateDir(runtime)),
		conns:   map[net.Conn]struct{}{},
		// The layout cache is written on the first graph view, so it has to
		// exist before the first request arrives.
		layouts: map[string]GraphLayout{},
	}
	// The model path renews a rejected OAuth credential through the same secret store
	// the login uses, so the runtime and the app share one refresher. Wiring it here
	// keeps the runtime free of the host's secret channel.
	if runtime != nil {
		runtime.options.OnCredentialRejected = app.recoverCredential
	}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.handler = app.guard(mux)
	// A device-code login outlives the daemon that started it: the refresh loop
	// has to be armed at startup, not only after someone opens the settings
	// page, or the one-hour access token would expire silently.
	if options.AppServices != nil && options.AppServices.PushSecret != nil {
		app.loginService()
	}
	return app
}

// ServeHTTP serves one request. The Fastify error handler became this
// recover: a RuntimeError is 400 {code,message} plus field when set.
func (app *GraphApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if recovered := recover(); recovered != nil {
			writePublic(w, recovered)
		}
	}()
	app.handler.ServeHTTP(w, r)
}

// Listen binds the console on loopback and returns its address.
func (app *GraphApp) Listen(host string, port int) (string, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return "", err
	}
	app.mutex.Lock()
	app.server = &http.Server{Handler: app}
	app.mutex.Unlock()
	go func() {
		_ = app.server.Serve(listener)
	}()
	return "http://" + listener.Addr().String(), nil
}

// Close stops the server.
func (app *GraphApp) Close() {
	app.mutex.Lock()
	server := app.server
	app.closed = true
	app.mutex.Unlock()
	if app.logins != nil {
		app.logins.close()
	}
	// The Pi extensions the daemon hosted run in processes of their own; they
	// stop with the daemon.
	ClosePigExtensions()
	if server != nil {
		_ = server.Close()
	}
}

// CloseAllConnections drops the open connections. A long-lived SSE stream
// must not keep the daemon from stopping.
func (app *GraphApp) CloseAllConnections() {
	app.mutex.Lock()
	conns := make([]net.Conn, 0, len(app.conns))
	for conn := range app.conns {
		conns = append(conns, conn)
	}
	app.mutex.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

// guard is the Fastify onRequest hook: the session cookie, the app bridge
// token and the local-origin rule.
func (app *GraphApp) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || strings.HasPrefix(path, "/assets/") || path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}
		// The desktop bridge authenticates with the per-process token written to
		// the state directory; the browser session cookie never reaches Electron.
		if strings.HasPrefix(path, "/api/app/") {
			token := r.Header.Get("x-graph-app-token")
			if app.options.AppServices == nil || token == "" || token != app.options.AppServices.AppToken {
				writeJSON(w, http.StatusForbidden, errorJSON{Code: "forbidden", Message: "App bridge token required"})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(path, "/api/") {
			Guard(app.session, r)
		}
		if origin := r.Header.Get("Origin"); origin != "" && LocalOrigin(origin) == "" {
			writeJSON(w, http.StatusForbidden, errorJSON{Code: "forbidden_origin", Message: "Local origin required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// recoverCredential renews the credential a rejected model request used.
//
// It resolves the model's provider from the live catalog and only renews a credential
// that carries a refresh bundle; a plain API key has nothing to renew, and its
// rejection is the honest answer to the request.
func (app *GraphApp) recoverCredential(modelId string) error {
	ref, ok := app.xaiCredentialForModel(modelId)
	if !ok {
		return fmt.Errorf("模型 %s 的凭据不是可刷新的 OAuth 凭据", modelId)
	}
	return app.loginService().xaiRefreshNow(context.Background(), ref)
}

// xaiCredentialForModel names the credential a model uses, when that credential is an
// xAI OAuth credential with a refresh bundle beside it.
func (app *GraphApp) xaiCredentialForModel(modelId string) (string, bool) {
	if app.runtime == nil {
		return "", false
	}
	provider := ""
	for _, entry := range app.runtime.liveEntries() {
		if entry.Id == modelId {
			provider = entry.Provider
			break
		}
	}
	if provider == "" {
		return "", false
	}
	for _, preset := range PLATFORM_PRESETS {
		if preset.OAuthProvider != "xai" {
			continue
		}
		if preset.ID != provider && preset.OAuthProvider != provider {
			continue
		}
		if strings.TrimSpace(app.appProviderSecrets()[preset.CredentialRef+xaiRefreshSuffix]) == "" {
			return "", false
		}
		return preset.CredentialRef, true
	}
	return "", false
}
