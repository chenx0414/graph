package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRouteInventoryReadsEveryRegistration(t *testing.T) {
	root := t.TempDir()
	body := `package graph

func routes() {
	mux.HandleFunc("GET /api/health", app.serveHealth)
	mux.HandleFunc("POST "+PROVIDER_ROUTES.Probe, app.serveProviderProbe)
	mux.HandleFunc("GET /api/projects/{projectId}/entries", app.serveProjectEntries)
}
`
	if err := os.MkdirAll(filepath.Join(root, "backend", "internal", "graph"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "backend", "internal", "graph", "server_app_routes.go"), []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	routes, err := readRouteInventory(root)
	if err != nil {
		t.Fatalf("read routes: %v", err)
	}
	if len(routes) < 2 {
		t.Fatalf("a route list must include the literal registrations, got %d: %v", len(routes), routes)
	}
	seen := map[string]bool{}
	for _, route := range routes {
		if route.Path == "" || route.Handler == "" {
			t.Fatalf("every route needs a path and a handler: %+v", route)
		}
		seen[route.Path] = true
	}
	for _, want := range []string{"/api/health", "/api/projects/{projectId}/entries"} {
		if !seen[want] {
			t.Errorf("route inventory is missing %q, got %v", want, seen)
		}
	}
}

func TestFeatureMapNamesEveryFeatureAndItsBacking(t *testing.T) {
	root := t.TempDir()
	writeFeatureFixture(t, root)
	if err := os.MkdirAll(filepath.Join(root, "backend", "internal", "graph"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	handler := `package graph

func (app *GraphApp) serveHealth(w http.ResponseWriter, r *http.Request) {}
func (app *GraphApp) serveConversations(w http.ResponseWriter, r *http.Request) {}
`
	if err := os.WriteFile(filepath.Join(root, "backend", "internal", "graph", "server_handlers.go"), []byte(handler), 0o644); err != nil {
		t.Fatalf("write handler: %v", err)
	}
	rendered, err := renderFeatureMap(root)
	if err != nil {
		t.Fatalf("render feature map: %v", err)
	}
	for _, want := range []string{
		"F-01",
		"启动与就绪",
		"/api/health",
		"serveHealth",
		"server_handlers.go",
		"generated",
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("feature map does not mention %q:\n%s", want, rendered)
		}
	}
}

func TestFeatureMapDriftFailsWhenTheRepositoryGrew(t *testing.T) {
	root := t.TempDir()
	writeFeatureFixture(t, root)
	if err := os.MkdirAll(filepath.Join(root, "backend", "internal", "graph"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	handler := `package graph

func (app *GraphApp) serveHealth(w http.ResponseWriter, r *http.Request) {}
func (app *GraphApp) serveConversations(w http.ResponseWriter, r *http.Request) {}
func (app *GraphApp) serveNewSurface(w http.ResponseWriter, r *http.Request) {}
`
	if err := os.WriteFile(filepath.Join(root, "backend", "internal", "graph", "server_handlers.go"), []byte(handler), 0o644); err != nil {
		t.Fatalf("write handler: %v", err)
	}
	registered := `package graph

func routes() {
	mux.HandleFunc("GET /api/health", app.serveHealth)
	mux.HandleFunc("GET /api/conversations", app.serveConversations)
	mux.HandleFunc("GET /api/new", app.serveNewSurface)
}
`
	if err := os.WriteFile(filepath.Join(root, "backend", "internal", "graph", "server_app_routes.go"), []byte(registered), 0o644); err != nil {
		t.Fatalf("write routes: %v", err)
	}
	rendered, err := renderFeatureMap(root)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "FEATURE_MAP.md"), []byte(rendered), 0o644); err != nil {
		t.Fatalf("write map: %v", err)
	}
	if code := runFeatureMap(root, nil); code != 0 {
		t.Fatalf("a freshly written map must pass, got %d", code)
	}
	stale := strings.Replace(rendered, "/api/new", "", 1)
	if err := os.WriteFile(filepath.Join(root, "FEATURE_MAP.md"), []byte(stale), 0o644); err != nil {
		t.Fatalf("write stale map: %v", err)
	}
	if code := runFeatureMap(root, nil); code == 0 {
		t.Fatal("a stale map must fail so the entry point list cannot drift")
	}
}

func writeFeatureFixture(t *testing.T, root string) {
	t.Helper()
	dir := filepath.Join(root, "verification", "skills", "verify-graph", "features")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	routes := filepath.Join(root, "backend", "internal", "graph")
	if err := os.MkdirAll(routes, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	registered := `package graph

func routes() {
	mux.HandleFunc("GET /api/health", app.serveHealth)
	mux.HandleFunc("GET /api/conversations", app.serveConversations)
}
`
	if err := os.WriteFile(filepath.Join(routes, "server_app_routes.go"), []byte(registered), 0o644); err != nil {
		t.Fatalf("write routes: %v", err)
	}
	index := `{"schema":1,"features":[
{"id":"F-01","title":"启动与就绪","entry":"CLI：launch / doctor","api":["/api/health"],"existingTests":["app/launch_test.go"],"command":"verification/verify-graph verify --journey F-01"},
{"id":"F-03","title":"会话列表与切换","entry":"左栏会话行","api":["/api/conversations"],"existingTests":["app/conversations_test.go"],"command":"verification/verify-graph verify --journey F-03"}
]}`
	if err := os.WriteFile(filepath.Join(dir, "index.json"), []byte(index), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
}
