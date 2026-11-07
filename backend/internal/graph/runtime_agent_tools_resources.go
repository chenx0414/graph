package graph

import (
	"strings"

	"errors"
)

func agentToolsResourcesHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"search_resources": func(id string, params map[string]any) any {
			query := ""
			if raw, ok := params["query"].(string); ok {
				query = strings.TrimSpace(raw)
			}
			if len(query) > 500 {
				panic(errors.New("Capability search query must be at most 500 characters"))
			}
			kind := agentToolsTrimmedString(params["kind"])
			if kind != "" && !agentToolsContains(agentToolsCapabilityKinds, kind) {
				panic(errors.New("Unsupported capability kind"))
			}
			role := agentToolsTrimmedString(params["role"])
			if role != "" && role != "agent" && role != "tool" {
				panic(errors.New("Prompt role must be agent or tool"))
			}
			search := CapabilitySearchInput{}
			if query != "" {
				search.Query = query
			}
			if kind != "" {
				search.Kind = kind
			}
			if role != "" {
				search.Role = role
			}
			if value, ok := agentToolsNumber(params["limit"]); ok {
				search.Limit = int(value)
			}
			if value, ok := agentToolsNumber(params["offset"]); ok {
				search.Offset = int(value)
			}
			result := asMap(input.Catalog.SearchCapabilities(search))
			items := []any{}
			for _, item := range asSlice(result["items"]) {
				items = append(items, agentToolsCapabilityView(asMap(item)))
			}
			view := map[string]any{}
			for key, value := range result {
				view[key] = value
			}
			view["items"] = items
			return agentToolsText(stringifyJSON(view))
		},
	}
}
