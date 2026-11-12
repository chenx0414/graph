package graph

type AgentToolsSpawnInput struct {
	Objective string
	Name      string
	Model     string
	Workspace string
	RequestId string
}

func spawnToolDeclarations(set agentToolContext) []AgentToolDeclaration {
	return []AgentToolDeclaration{
		{
			Name:  "spawn_agent",
			Label: "Spawn a child Agent",
			Description: "Spawn a child Agent that works on one objective with its own durable conversation and workspace. " +
				"It returns immediately; when the child settles, its result is delivered back to you as a message. " +
				"Use it to split genuinely independent work. Spawning is bounded by the configured depth, children-per-Agent and total-Agent limits.",
			Parameters: tbObject([]tbField{
				{"objective", tbString(nil)},
				{"name", tbOptional(tbString(nil))},
				{"model", tbOptional(tbString(nil))},
				{"workspace", tbOptional(tbString(nil))},
				{"requestId", tbOptional(tbString(nil))},
			}, []string{"objective"}),
			Available: set.features.Spawn,
		},
	}
}
