package graph

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

func CreateApp(runtime *TaskRuntime, options AppOptions) *GraphApp {
	app := &GraphApp{
		runtime: runtime,
		options: options,
		session: LoadOrCreateSession(appSessionStateDir(runtime)),
		conns:   map[net.Conn]struct{}{},
		layouts: map[string]GraphLayout{},
	}
	if runtime != nil {
		runtime.options.OnCredentialRejected = app.scheduleCredentialRecovery
	}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.handler = app.guard(mux)
	if options.AppServices != nil && options.AppServices.PushSecret != nil {
		app.loginService()
	}
	return app
}

func (app *GraphApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if recovered := recover(); recovered != nil {
			writePublic(w, recovered)
		}
	}()
	app.handler.ServeHTTP(w, r)
}

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

func (app *GraphApp) Close() {
	app.mutex.Lock()
	server := app.server
	app.closed = true
	app.mutex.Unlock()
	if app.logins != nil {
		app.logins.close()
	}
	ClosePigExtensions()
	if server != nil {
		_ = server.Close()
	}
}

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

func (app *GraphApp) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || strings.HasPrefix(path, "/assets/") || path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}
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

func (app *GraphApp) scheduleCredentialRecovery(request CredentialRecoveryRequest) bool {
	ref, ok := app.xaiCredentialForModel(request.Model)
	if !ok {
		return false
	}
	go func() {
		if err := app.loginService().xaiRefreshNow(context.Background(), ref); err != nil {
			app.runtime.store.SettleNodeOutput(request.TaskId, request.NodeId, "failed", request.Output, request.OperationId)
			app.runtime.store.Event(request.TaskId, "node.credential_refresh_failed", map[string]any{
				"nodeId": request.NodeId, "error": err.Error(),
			})
			return
		}
		store := app.runtime.store
		store.RetryNodeOutput(request.TaskId, request.NodeId, request.Output, request.OperationId)
		store.RetryActivation(request.ActivationId)
		store.Event(request.TaskId, "node.credential_refreshed", map[string]any{
			"nodeId": request.NodeId, "reason": "OAuth 凭据已刷新，重跑本轮",
		})
		if app.runtime.execution != nil {
			app.runtime.execution.Kick()
		}
	}()
	return true
}

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
		if !app.loginService().hasXaiBundle(preset.CredentialRef) {
			return "", false
		}
		return preset.CredentialRef, true
	}
	return "", false
}
