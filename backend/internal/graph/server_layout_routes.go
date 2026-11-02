package graph

import (
	"encoding/json"
	"net/http"
)

func layoutParentMap(input LayoutInput) map[string]string {
	parents := map[string]string{}
	for _, group := range input.Containers {
		parents[group.ID] = group.Parent
	}
	for _, node := range input.Nodes {
		parents[node.ID] = node.Container
	}
	return parents
}

// serveLayoutRoutes runs the layout module's orthogonal router for one folded
// picture. The caller supplies the visible boxes; this does not place nodes again.
func (app *GraphApp) serveLayoutRoutes(w http.ResponseWriter, r *http.Request) {
	raw, err := json.Marshal(appJSONBody(w, r))
	if err != nil {
		panic(err)
	}
	var request struct {
		Edges     []LayoutEdge              `json:"edges"`
		Positions map[string]LayoutPosition `json:"positions"`
		NodeIDs   []string                  `json:"nodeIds"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		Raise("invalid_input", "Layout routes require edges, positions and nodeIds")
	}
	if request.Positions == nil {
		request.Positions = map[string]LayoutPosition{}
	}
	for _, edge := range request.Edges {
		if edge.ID == "" || edge.Source == "" || edge.Target == "" {
			Raise("invalid_input", "Each layout edge needs an id, source and target")
		}
		if _, ok := request.Positions[edge.Source]; !ok {
			Raise("invalid_input", "Missing layout endpoint for "+edge.ID)
		}
		if _, ok := request.Positions[edge.Target]; !ok {
			Raise("invalid_input", "Missing layout endpoint for "+edge.ID)
		}
	}
	// The router walks its own grid and panics when a connector cannot be routed.
	// That is a fact about the geometry the caller sent, not a broken daemon:
	// measured 2026-11-02, two boxes 200px apart answered 500 while the same
	// boxes 192px apart answered 200, because 200 is not a multiple of the 16px
	// layout grid.
	routes := map[string][]LayoutPoint{}
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				Raise("invalid_input", "These boxes cannot be routed: every x, y, width and height must sit on the "+
					itoa(layoutGRID)+"px layout grid, and no connector may cross a box")
			}
		}()
		routes = OrthogonalRoutes(request.Edges, request.Positions, request.NodeIDs)
	}()
	if routes == nil {
		routes = map[string][]LayoutPoint{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"routes": routes})
}
