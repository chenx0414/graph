package graph

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
)

// The System tool group of the Agent tool table.
//
// The table was one map inside one function; every handler body here is the
// text that was there before, moved. The group function takes the values the
// closures captured as named parameters, so the moved bodies are unchanged.

// agentToolsSystemHandlers are the handlers of the System tools.
func agentToolsSystemHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"read_system_capabilities": func(id string, params map[string]any) any {
			inventory := input.SystemContext.SystemSummary()
			if os.Getenv("GRAPH_SCOPED_SYSTEM_CAPABILITIES") != "1" {
				return agentToolsText(stringifyJSON(inventory))
			}
			raw, present := params["section"]
			if !present || raw == nil {
				return agentToolsText(stringifyJSON(inventory))
			}
			section, ok := raw.(string)
			if !ok {
				Raise("invalid_input", "Unknown system capability section")
			}
			value, exists := inventory[section]
			if !exists {
				Raise("invalid_input", "Unknown system capability section")
			}
			return agentToolsText(stringifyJSON(map[string]any{section: value}))
		},
		"inspect_graph_system": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.SystemContext.SystemDiagnostics()))
		},
		"propose_system_change": func(id string, params map[string]any) any {
			title := strings.TrimSpace(agentToolsString(params["title"]))
			problem := strings.TrimSpace(agentToolsString(params["problem"]))
			var impact *string
			if raw, ok := params["impact"].(string); ok {
				value := strings.TrimSpace(raw)
				impact = &value
			}
			var risk *string
			if raw, ok := params["risk"].(string); ok {
				value := strings.TrimSpace(raw)
				risk = &value
			}
			if title == "" || len(title) > 200 {
				panic(errors.New("A system-change title of at most 200 characters is required"))
			}
			if problem == "" || len(problem) > 4_000 {
				panic(errors.New("A concrete problem statement of at most 4000 characters is required"))
			}
			if impact != nil && len(*impact) > 2_000 {
				panic(errors.New("System-change impact must be at most 2000 characters"))
			}
			if risk != nil && len(*risk) > 2_000 {
				panic(errors.New("System-change risk must be at most 2000 characters"))
			}
			serialized := agentToolsString(params["changeJson"])
			if strings.TrimSpace(serialized) == "" || len(serialized) > 250_000 {
				panic(errors.New("changeJson must be a bounded JSON document"))
			}
			var change any
			if err := json.Unmarshal([]byte(serialized), &change); err != nil {
				panic(errors.New("changeJson must be a bounded JSON document"))
			}
			record := asMap(change)
			if record == nil {
				panic(errors.New("changeJson must describe one object"))
			}
			return agentToolsText(stringifyJSON(input.SystemContext.ProposeSystemChange(AgentToolsSystemChange{
				Title: title, Problem: problem, Change: record, Impact: impact, Risk: risk,
			})))
		},
		"apply_system_change": func(id string, params map[string]any) any {
			proposalID := strings.TrimSpace(agentToolsString(params["proposalId"]))
			if proposalID == "" || len(proposalID) > 200 {
				panic(errors.New("A bounded proposalId is required"))
			}
			return agentToolsText(stringifyJSON(input.SystemContext.ApplySystemChange(proposalID)))
		},
		"inspect_rsi_status": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Rsi.Status(false)))
		},
		"apply_rsi_change": func(id string, params map[string]any) any {
			title := strings.TrimSpace(agentToolsStringOrEmpty(params["title"]))
			problem := strings.TrimSpace(agentToolsStringOrEmpty(params["problem"]))
			if title == "" || len(title) > 200 {
				panic(errors.New("An RSI title of at most 200 characters is required"))
			}
			if problem == "" || len(problem) > 4_000 {
				panic(errors.New("A concrete RSI problem of at most 4000 characters is required"))
			}
			receipt := input.Rsi.Apply(params, input.RsiContext)
			result := agentToolsText(stringifyJSON(receipt))
			record := asMap(receipt)
			if record != nil {
				status, _ := record["status"].(string)
				restartRequired, _ := record["restartRequired"].(bool)
				if status == "applied" && restartRequired {
					result["terminate"] = true
				}
			}
			return result
		},
	}
}
