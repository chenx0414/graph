package graph

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// appDefaultPage is the placeholder console page.
func appDefaultPage() string {
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Graph</title></head><body><div id=\"root\">Graph</div></body></html>"
}

// serveAssets serves the built console files.
func (app *GraphApp) serveAssets(w http.ResponseWriter, r *http.Request) {
	relative := r.PathValue("path")
	if relative == "" {
		writeJSON(w, http.StatusNotFound, errorJSON{Code: "not_found", Message: "Not found"})
		return
	}
	root := filepath.Clean(app.options.WebDir)
	file := filepath.Clean(filepath.Join(root, "assets", relative))
	if !strings.HasPrefix(file, root+string(os.PathSeparator)) {
		writeJSON(w, http.StatusForbidden, errorJSON{Code: "forbidden", Message: "Asset path escapes the console root"})
		return
	}
	body, err := os.ReadFile(file)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorJSON{Code: "not_found", Message: "Not found"})
		return
	}
	kind := "text/javascript"
	if strings.HasSuffix(relative, ".css") {
		kind = "text/css"
	} else if strings.HasSuffix(relative, ".json") {
		kind = "application/json"
	} else if strings.HasSuffix(relative, ".png") {
		kind = "image/png"
	}
	w.Header().Set("Content-Type", kind)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// serveHealth is the health probe.
func (app *GraphApp) serveHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, appHealth{OK: true})
}

// serveStartup is the boot snapshot the console reads.
func (app *GraphApp) serveStartup(w http.ResponseWriter, r *http.Request) {
	if app.options.StartupInfo != nil {
		writeJSON(w, http.StatusOK, app.options.StartupInfo())
		return
	}
	if app.options.Startup != nil {
		writeJSON(w, http.StatusOK, *app.options.Startup)
		return
	}
	writeJSON(w, http.StatusOK, StartupInfo{Mode: "view", Configured: false, ModelCount: 0, EnabledModelCount: 0})
}
