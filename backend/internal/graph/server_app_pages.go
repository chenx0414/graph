package graph

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// appDefaultPage is the placeholder console page.
func appDefaultPage() string {
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Graph</title></head><body><div id=\"root\">Graph</div></body></html>"
}

// contentHashedAssetName matches the names the console build gives the files it
// publishes: vite emits `index-CdM9mI3F.js`, `api-DygE7xRZ.js`. The hash is the
// content, so the name can never later mean different bytes - that is what
// makes it safe to cache without asking again.
var contentHashedAssetName = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$`)

// serveAssets serves the built console files.
//
// The shell document is no-store, so a rebuilt console always publishes the
// names it currently names; the bytes behind those names are then either
// content-hashed (cache forever) or not (ask again). Measured 2026-11-03: the
// assets carried no cache directive at all, so every reload re-fetched the
// whole bundle - correct, but the one case the hash exists to avoid.
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
	// A name without a hash keeps its identity while its bytes may change, so
	// it must be revalidated; the hash is the identity, so it need not be.
	if contentHashedAssetName.MatchString(relative) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
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
