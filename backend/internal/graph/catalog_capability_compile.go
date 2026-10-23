package graph

import (
	"strings"
)

// AgentCombinations validates every recipe against the current capability projection.
func (library *CapabilityLibrary) AgentCombinations() []AgentCombinationView {
	views := make([]AgentCombinationView, 0, len(library.recipes))
	for _, recipe := range library.recipes {
		views = append(views, ValidateAgentCombination(recipe, library.capabilitiesCache))
	}
	return views
}

// AgentCombination resolves one recipe by id.
func (library *CapabilityLibrary) AgentCombination(id string) *AgentCombinationView {
	views := library.AgentCombinations()
	for i := range views {
		if views[i].Id == id {
			return &views[i]
		}
	}
	return nil
}

// SearchAgentCombinations filters the recipe list.
func (library *CapabilityLibrary) SearchAgentCombinations(input AgentCombinationSearchInput) AgentCombinationSearchResult {
	query := strings.ToLower(strings.TrimSpace(input.Query))
	if len(query) > 200 {
		Raise("invalid_input", "Agent combination query must be at most 200 characters")
	}
	limit := 30
	if input.Limit > 0 {
		limit = min(input.Limit, 50)
	}
	matches := []AgentCombinationView{}
	for _, item := range library.AgentCombinations() {
		if input.Grade != "" && !ModelGradeMatches(input.Grade, item.RecommendedGrade) {
			continue
		}
		if query == "" {
			matches = append(matches, item)
			continue
		}
		parts := []string{item.Id, item.Name, item.Description, string(item.RecommendedGrade)}
		parts = append(parts, item.Tags...)
		for _, resource := range item.Resources {
			parts = append(parts, resource.ResourceId)
		}
		if strings.Contains(strings.ToLower(strings.Join(parts, "\n")), query) {
			matches = append(matches, item)
		}
	}
	items := matches
	if len(items) > limit {
		items = items[:limit]
	}
	return AgentCombinationSearchResult{Total: len(matches), Items: items}
}

// SaveAgentCombination persists one recipe and returns its validated view.
func (library *CapabilityLibrary) SaveAgentCombination(combination AgentCombination) AgentCombinationView {
	if library.recipesPath == "" {
		Raise("unsupported", "This runtime has no agent-combination file")
	}
	if combination.Mode == "main" && combination.Id != "main" {
		Raise("invalid_agent_combination", "The Main Agent recipe must use id \"main\"")
	}
	if combination.Resources == nil {
		combination.Resources = []AgentCombinationResource{}
	}
	if combination.Tags == nil {
		combination.Tags = []string{}
	}
	combined := []AgentCombination{}
	for _, item := range library.recipes {
		if item.Id != combination.Id {
			combined = append(combined, item)
		}
	}
	combined = append(combined, combination)
	document := ParseAgentCombinations(AgentCombinationDocument{Version: 1, Combinations: combined})
	next := document.Combinations
	view := ValidateAgentCombination(combination, library.capabilitiesCache)
	if view.Status != "valid" {
		Raise("invalid_agent_combination", strings.Join(view.Issues, "; "))
	}
	WriteAgentCombinations(library.recipesPath, AgentCombinationDocument{Version: document.Version, Combinations: next})
	library.recipes = next
	return ValidateAgentCombination(combination, library.capabilitiesCache)
}

// UpdateAgentCombinationDescription rewrites one recipe description.
func (library *CapabilityLibrary) UpdateAgentCombinationDescription(id string, description string) AgentCombinationView {
	if library.recipesPath == "" {
		Raise("unsupported", "This runtime has no agent-combination file")
	}
	current := AgentCombination{}
	found := false
	for _, item := range library.recipes {
		if item.Id == id {
			current = item
			found = true
			break
		}
	}
	if !found {
		Raise("not_found", "Unknown Agent combination "+id)
	}
	normalized := strings.TrimSpace(description)
	if normalized == "" {
		Raise("invalid_agent_combination", "Agent combination description must be a nonempty string")
	}
	if len([]rune(normalized)) > 2000 {
		Raise("invalid_agent_combination", "Agent combination description must be at most 2000 characters")
	}
	current.Description = normalized
	return library.SaveAgentCombination(current)
}

// DeleteAgentCombination removes one recipe.
func (library *CapabilityLibrary) DeleteAgentCombination(id string) DeletedAgentCombination {
	if library.recipesPath == "" {
		Raise("unsupported", "This runtime has no agent-combination file")
	}
	for _, item := range library.recipes {
		if item.Id == id && item.Mode == "main" {
			Raise("invalid_agent_combination", "The Main Agent recipe cannot be deleted")
		}
	}
	next := []AgentCombination{}
	for _, item := range library.recipes {
		if item.Id != id {
			next = append(next, item)
		}
	}
	if len(next) == len(library.recipes) {
		Raise("not_found", "Unknown Agent combination "+id)
	}
	WriteAgentCombinations(library.recipesPath, AgentCombinationDocument{Version: 1, Combinations: next})
	library.recipes = next
	return DeletedAgentCombination{Id: id, Deleted: true}
}
