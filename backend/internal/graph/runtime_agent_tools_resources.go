package graph

import (
	"errors"
	"strings"
)

// The Resources tool group of the Agent tool table.
//
// The table was one map inside one function; every handler body here is the
// text that was there before, moved. The group function takes the values the
// closures captured as named parameters, so the moved bodies are unchanged.

// agentToolsResourcesHandlers are the handlers of the Resources tools.
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
		"get_resource": func(id string, params map[string]any) any {
			resourceID, version := agentToolsResourceReference(params["id"], params["version"])
			if resourceID == "" || len(resourceID) > 160 {
				panic(errors.New("A bounded resource id is required"))
			}
			entry := input.Catalog.Capability(resourceID, version)
			if entry == nil {
				hint := " Use the exact id and version returned by search_resources."
				if input.Catalog.AgentCombination(resourceID) != nil {
					hint = ` "` + resourceID + `" is an Agent recipe id; use get_agent_combination instead.`
				}
				message := "Unknown capability " + resourceID
				if version != "" {
					message += "@" + version
				}
				panic(errors.New(message + "." + hint))
			}
			return agentToolsText(stringifyJSON(agentToolsCapabilityView(asMap(entry))))
		},
		"list_agent_combinations": func(id string, params map[string]any) any {
			query := ""
			if raw, ok := params["query"].(string); ok {
				query = strings.ToLower(strings.TrimSpace(raw))
			}
			if len(query) > 200 {
				panic(errors.New("Agent combination query must be at most 200 characters"))
			}
			grade := ""
			if raw, ok := params["grade"].(string); ok {
				grade = strings.TrimSpace(raw)
			}
			if grade != "" && !agentToolsHasModelGrade(grade) {
				panic(errors.New("Unsupported model grade"))
			}
			limit := 30
			if value, ok := agentToolsNumber(params["limit"]); ok && value > 0 {
				limit = int(value)
				if limit > 50 {
					limit = 50
				}
			}
			search := AgentCombinationSearchInput{}
			if query != "" {
				search.Query = query
			}
			if grade != "" {
				search.Grade = ModelGrade(grade)
			}
			search.Limit = limit
			return agentToolsText(stringifyJSON(input.Catalog.SearchAgentCombinations(search)))
		},
		"get_agent_combination": func(id string, params map[string]any) any {
			combinationID := strings.TrimSpace(agentToolsString(params["id"]))
			if combinationID == "" || len(combinationID) > 160 {
				panic(errors.New("A bounded Agent combination id is required"))
			}
			combination := input.Catalog.AgentCombination(combinationID)
			if combination == nil {
				hint := " Use list_agent_combinations to discover available recipe ids."
				if match := agentToolsVersionedID.FindStringSubmatch(combinationID); match != nil {
					recipe := input.Catalog.AgentCombination(match[1])
					if recipe != nil {
						hint = " Use get_agent_combination(" + stringifyJSON(map[string]any{"id": recipe.Id}) +
							") for current recipe details. A graph node's recipe field uses a versioned definition reference; this lookup takes the stable recipe id and does not resolve historical definitions."
					}
				}
				panic(errors.New("Unknown Agent combination " + combinationID + "." + hint))
			}
			return agentToolsText(stringifyJSON(combination))
		},
	}
}
