package graph

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

var consoleBundlePattern = regexp.MustCompile(`assets/index-[A-Za-z0-9_-]+\.js`)

func (app *GraphApp) serveBuild(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"bundle": app.consoleBundle()})
}

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
