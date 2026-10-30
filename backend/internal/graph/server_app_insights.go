package graph

import "net/http"

// serveInsights is the folded record behind the 洞察 page.
//
// One request answers the whole page: the billed tokens, the models that billed
// them, the tools that ran beside them and the time each side took. The scope
// comes from the query so the page can narrow to a project or one conversation
// without a second endpoint.
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
