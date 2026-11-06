package graph

import (
	"errors"
	"os"
	"strings"
)

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
