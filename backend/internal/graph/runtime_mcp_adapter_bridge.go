package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// MCP_RUNTIME_REGISTER_EVENT is the bus event pi-mcp-adapter listens for.
const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1"

const mcpRuntimeRegisterVersion = 1

// MCP_ADAPTER_PROXY_TOOL is the adapter gateway tool name.
const MCP_ADAPTER_PROXY_TOOL = "mcp"

// McpAdapterServerRef is one server handed to the adapter.
type McpAdapterServerRef struct {
	Name       string `json:"name"`
	Definition any    `json:"definition"`
}

// McpAdapterBridgeSpec describes the inline extension the Node worker would install.
// TODO(port): the Pi InlineExtension factory is not executable in Go. The resident worker still registers servers.
type McpAdapterBridgeSpec struct {
	Name      string                `json:"name"`
	Hidden    bool                  `json:"hidden"`
	Servers   []McpAdapterServerRef `json:"servers"`
	Event     string                `json:"event"`
	Version   int                   `json:"version"`
	ProxyTool string                `json:"proxyTool"`
}

// McpAdapterFact is one bound capability the bridge may turn into a server.
type McpAdapterFact struct {
	Id      string
	Version string
	Kind    string
	Path    string
	Role    string
}

// McpAdapterBridge returns the registration description for every bound MCP server.
func McpAdapterBridge(servers []McpAdapterServerRef, report func(string)) McpAdapterBridgeSpec {
	if report == nil {
		report = func(message string) { _, _ = os.Stderr.WriteString(message + "\n") }
	}
	_ = report
	return McpAdapterBridgeSpec{
		Name: "graph-mcp-adapter", Hidden: true, Servers: servers,
		Event: MCP_RUNTIME_REGISTER_EVENT, Version: mcpRuntimeRegisterVersion, ProxyTool: MCP_ADAPTER_PROXY_TOOL,
	}
}

// McpAdapterServers reads capability.json and resolves transports. A declaration with no transport is skipped.
func McpAdapterServers(facts []McpAdapterFact, secrets map[string]string) []McpAdapterServerRef {
	servers := []McpAdapterServerRef{}
	for _, fact := range facts {
		if fact.Kind != "mcp" || (fact.Role != "" && fact.Role != "tool") || fact.Path == "" || strings.TrimSpace(fact.Id) == "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fact.Path, "capability.json"))
		if err != nil {
			panic(err)
		}
		var manifest any
		if err := json.Unmarshal(raw, &manifest); err != nil {
			panic(err)
		}
		declaration, _ := manifest.(map[string]any)
		if declaration == nil {
			declaration = map[string]any{}
		}
		input := McpAdapterServerDeclaration{}
		if value, ok := declaration["command"]; ok {
			input.Command = value
		}
		if value, ok := declaration["args"]; ok {
			input.Args = value
		}
		if value, ok := declaration["url"]; ok {
			input.Url = value
		}
		if value, ok := declaration["headers"]; ok {
			input.Headers = value
		}
		if value, ok := declaration["headersEnv"]; ok {
			input.HeadersEnv = value
		}
		if value, ok := declaration["env"]; ok {
			input.Env = value
		}
		definition := McpAdapterServerDefinitionFrom(input, secrets, fact.Path)
		if definition == nil {
			continue
		}
		servers = append(servers, McpAdapterServerRef{Name: McpAdapterServerName(fact.Id), Definition: definition})
	}
	return servers
}
