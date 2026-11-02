package graph

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

// consoleBundlePattern is the built entry bundle the served index.html names.
var consoleBundlePattern = regexp.MustCompile(`assets/index-[A-Za-z0-9_-]+\.js`)

// serveBuild reports the console bundle the daemon serves right now.
//
// A console tab keeps running whatever bundle it loaded, and an update leaves it
// looking current while its code is old: measured 2026-11-01, the same stale page
// was twice read as "the change did not take". The page polls this and offers a
// refresh instead of reloading under the person's hands.
func (app *GraphApp) serveBuild(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"bundle": app.consoleBundle()})
}

// consoleBundle is the entry bundle named by the index.html this daemon serves,
// or an empty string when the console has no built page.
func (app *GraphApp) consoleBundle() string {
	if app.options.WebDir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(app.options.WebDir, "index.html"))
	if err != nil {
		return ""
	}
	return consoleBundlePattern.FindString(string(raw))
}
