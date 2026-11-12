package graph

import "strings"

func agentToolsSpawnHandlers(input AgentToolsInput) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"spawn_agent": func(id string, params map[string]any) any {
			if input.Spawn == nil {
				panic(errorString("This Agent session cannot spawn children"))
			}
			objective := strings.TrimSpace(agentToolsStringOrEmpty(params["objective"]))
			if objective == "" {
				panic(errorString("objective is required: say what the child Agent must accomplish"))
			}
			receipt := input.Spawn(AgentToolsSpawnInput{
				Objective: objective,
				Name:      strings.TrimSpace(agentToolsStringOrEmpty(params["name"])),
				Model:     strings.TrimSpace(agentToolsStringOrEmpty(params["model"])),
				Workspace: strings.TrimSpace(agentToolsStringOrEmpty(params["workspace"])),
				RequestId: strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"])),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
	}
}
