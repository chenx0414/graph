package graph

var LOCAL_MCP_COMMANDS = []string{"node", "npx", "uvx"}

func IsLocalMcpCommand(value string) bool {
	for _, command := range LOCAL_MCP_COMMANDS {
		if command == value {
			return true
		}
	}
	return false
}
