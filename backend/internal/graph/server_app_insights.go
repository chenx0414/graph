package graph

import "net/http"

func (app *GraphApp) serveInsights(w http.ResponseWriter, r *http.Request) {
	scope := InsightsScope{Kind: r.URL.Query().Get("scope"), ID: r.URL.Query().Get("id")}
	switch scope.Kind {
	case "project", "conversation":
		if scope.ID == "" {
			Raise("invalid_input", "scope="+scope.Kind+" requires an id")
		}
	default:
		scope = InsightsScope{Kind: "global"}
	}
	writeJSON(w, http.StatusOK, app.runtime.Insights(scope))
}
