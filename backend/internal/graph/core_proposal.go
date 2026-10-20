package graph

import (
	"encoding/json"
	"strings"
)

// ValidateProposal checks static structure before any node or instance is created.
// A map keeps legacy keys (nodes, loops, containers) that a struct unmarshal drops.
func ValidateProposal(proposal any) {
	invalid := func(reason string) { Raise("invalid_proposal", reason) }
	record, legacy := proposalRecord(proposal)
	if len(legacy) > 0 {
		invalid("Native drafts use definition only; remove legacy fields: " + strings.Join(legacy, ", "))
	}
	version, versionOK := record["requirementVersion"]
	summary, _ := record["summary"].(string)
	if !versionOK || !jsSafeInteger(version) || numberValue(version) < 1 || !proposalText(summary) {
		invalid("A requirement version and summary are required")
	}
	definition, hasDefinition := record["definition"]
	if !hasDefinition || definition == nil {
		invalid("A native graph definition is required; legacy DAG drafts are retired")
	}
	parsed := ParseGraphDefinition(definition)
	if _, ok := record["decisions"]; ok {
		items, isArray := record["decisions"].([]any)
		if !isArray || len(items) > 50 {
			invalid("Decisions must be a bounded list of nonempty strings")
		}
		for _, item := range items {
			text, isString := item.(string)
			if !isString || strings.TrimSpace(text) == "" || len(text) > 800 {
				invalid("Decisions must be a bounded list of nonempty strings")
			}
		}
	}
	acceptance, isArray := record["acceptance"].([]any)
	if !isArray || len(acceptance) == 0 {
		invalid("At least one acceptance check is required")
	}
	seen := map[string]bool{}
	for _, item := range acceptance {
		entry, ok := item.(map[string]any)
		if !ok {
			invalid("Each acceptance item must name a node or module in the graph definition")
		}
		id, _ := entry["id"].(string)
		if seen[id] {
			invalid("Acceptance IDs must be unique")
		}
		seen[id] = true
	}
	if len(parsed.Acceptance) != len(acceptance) {
		invalid("Draft acceptance must match every criterion in the graph definition")
	}
	for _, item := range acceptance {
		entry := item.(map[string]any)
		id, _ := entry["id"].(string)
		description, _ := entry["description"].(string)
		checkNode, _ := entry["checkNode"].(string)
		_, nodeKnown := parsed.Nodes[checkNode]
		_, moduleKnown := parsed.Modules[checkNode]
		if !proposalText(id) || !proposalText(description) || (!nodeKnown && !moduleKnown) {
			invalid("Each acceptance item must name a node or module in the graph definition")
		}
		var criterion *AcceptanceCriterion
		for i := range parsed.Acceptance {
			if parsed.Acceptance[i].Id == id {
				criterion = &parsed.Acceptance[i]
				break
			}
		}
		if criterion == nil || criterion.Description != description ||
			(criterion.Kind == "check" && criterion.Module != checkNode) ||
			(criterion.Kind == "review" && criterion.Node != checkNode) {
			invalid("Draft acceptance IDs, descriptions and check targets must match the graph definition")
		}
	}
}

func proposalText(value string) bool {
	return strings.TrimSpace(value) != ""
}

func proposalRecord(proposal any) (map[string]any, []string) {
	if record, ok := proposal.(map[string]any); ok {
		var legacy []string
		for _, field := range []string{"nodes", "loops", "containers"} {
			if _, exists := record[field]; exists {
				legacy = append(legacy, field)
			}
		}
		return record, legacy
	}
	if native, ok := proposal.(NativeProposal); ok {
		record := map[string]any{
			"requirementVersion": float64(native.RequirementVersion),
			"summary":            native.Summary,
			"definition":         native.Definition,
			"acceptance":         acceptanceAny(native.Acceptance),
		}
		if native.Decisions != nil {
			items := make([]any, len(native.Decisions))
			for i, item := range native.Decisions {
				items[i] = item
			}
			record["decisions"] = items
		}
		return record, nil
	}
	encoded, err := json.Marshal(proposal)
	if err != nil {
		panic(err)
	}
	var record map[string]any
	if err := json.Unmarshal(encoded, &record); err != nil {
		panic(err)
	}
	return proposalRecord(record)
}

func acceptanceAny(items []AcceptanceItem) []any {
	out := make([]any, len(items))
	for i, item := range items {
		out[i] = map[string]any{"id": item.Id, "description": item.Description, "checkNode": item.CheckNode}
	}
	return out
}

func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	default:
		return 0
	}
}
