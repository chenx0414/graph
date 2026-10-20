package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/mcp"
)

// The kernel connects MCP servers itself.
//
// The Graph decides which servers a session may use and which secrets they
// get; the kernel owns the connection, the tool list and the call. The model
// reaches a server's tools under PiG's own naming, `mcp__<server>__<tool>`,
// so no gateway tool and no extension stand between the model and the
// server.

// McpServerSpec is one MCP server the kernel connects.
type McpServerSpec struct {
	// Name is the server name. The tool namespace is `mcp__<name>__`.
	Name string
	// Command and Args start a stdio server.
	Command string
	Args    []string
	Cwd     string
	// Env is the environment the stdio server runs with.
	Env map[string]string
	// URL connects a streamable HTTP server. It wins over Command.
	URL string
	// Headers are the headers an HTTP server receives.
	Headers map[string]string
}

// mcpConnection is one connected MCP server.
type mcpConnection struct {
	spec   McpServerSpec
	client *mcp.Client
}

// connectMcpServers connects the servers and returns their tools.
//
// A server that cannot be connected is an error: the session promised the
// model those tools, and a session that silently loses one is worse than a
// session that refuses to start.
func connectMcpServers(ctx context.Context, specs []McpServerSpec, recorder *callRecorder) ([]*mcpConnection, []*durable.ToolRegistration, error) {
	connections := []*mcpConnection{}
	registrations := []*durable.ToolRegistration{}
	for _, spec := range specs {
		transport, err := mcpTransport(spec)
		if err != nil {
			closeMcpServers(connections)
			return nil, nil, err
		}
		client := mcp.NewClient(mcp.ClientOptions{Implementation: mcp.Implementation{Name: "graph", Version: "1"}})
		if _, err := client.Connect(ctx, transport); err != nil {
			closeMcpServers(connections)
			return nil, nil, fmt.Errorf("pig kernel: MCP server %s: %w", spec.Name, err)
		}
		connection := &mcpConnection{spec: spec, client: client}
		connections = append(connections, connection)
		tools, err := client.ListTools(ctx, mcp.RequestOptions{})
		if err != nil {
			closeMcpServers(connections)
			return nil, nil, fmt.Errorf("pig kernel: MCP server %s: %w", spec.Name, err)
		}
		for _, tool := range tools {
			registrations = append(registrations, connection.toolRegistration(tool, recorder))
		}
	}
	return connections, registrations, nil
}

// closeMcpServers closes the connections of a failed setup.
func closeMcpServers(connections []*mcpConnection) {
	for _, connection := range connections {
		_ = connection.client.Close()
	}
}

// mcpTransport builds the transport of one server.
func mcpTransport(spec McpServerSpec) (mcp.Transport, error) {
	if spec.URL != "" {
		headers := map[string]string{}
		for name, value := range spec.Headers {
			headers[name] = value
		}
		transport, err := mcp.NewStreamableHTTPTransport(mcp.StreamableHTTPTransportOptions{URL: spec.URL, Headers: headers})
		if err != nil {
			return nil, fmt.Errorf("pig kernel: MCP server %s: %w", spec.Name, err)
		}
		return transport, nil
	}
	if spec.Command == "" {
		return nil, fmt.Errorf("pig kernel: MCP server %s has neither a command nor a url", spec.Name)
	}
	return mcp.NewStdioTransport(mcp.StdioTransportOptions{
		Command: spec.Command,
		Args:    spec.Args,
		Cwd:     spec.Cwd,
		Env:     spec.Env,
	}), nil
}

// toolRegistration turns one server tool into a tool the model may call.
func (connection *mcpConnection) toolRegistration(tool mcp.Tool, recorder *callRecorder) *durable.ToolRegistration {
	server := connection.spec.Name
	name := tool.Name
	return &durable.ToolRegistration{
		ToolSchema: ai.ToolSchema{
			Name:        mcpToolName(server, name),
			Description: tool.Description,
			Parameters:  jsonSchemaToParameters(tool.InputSchema),
		},
		Execute: func(ctx context.Context, args any, _ durable.ToolExecutionApi) (durable.ToolExecutionResult, error) {
			recorder.record(mcpToolName(server, name))
			result, err := connection.client.CallTool(ctx, name, args, mcp.RequestOptions{})
			if err != nil {
				return durable.ToolExecutionResult{
					Output:  []ai.ToolResultMessageContent{ai.TextContent{Text: "MCP call failed: " + err.Error()}},
					IsError: boolPointer(true),
				}, nil
			}
			text := mcpResultText(result)
			failed := result.IsError != nil && *result.IsError
			return durable.ToolExecutionResult{
				Output:  []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
				IsError: boolPointer(failed),
			}, nil
		},
	}
}

// mcpToolName is the name the model calls one server tool by.
func mcpToolName(server, tool string) string {
	return "mcp__" + mcpNamePart(server) + "__" + mcpNamePart(tool)
}

// mcpNamePart sanitizes one name part: every character other than letters,
// digits and an underscore becomes an underscore.
func mcpNamePart(value string) string {
	out := []rune{}
	for _, character := range value {
		switch {
		case character >= 'a' && character <= 'z', character >= 'A' && character <= 'Z', character >= '0' && character <= '9', character == '_':
			out = append(out, character)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}

// mcpResultText renders a tool result as the text the model reads.
func mcpResultText(result *mcp.CallToolResult) string {
	if result == nil {
		return ""
	}
	parts := []string{}
	for _, block := range result.Content {
		if block.Type == mcp.ContentText && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	text := strings.Join(parts, "\n")
	if text == "" && len(result.StructuredContent) > 0 {
		return string(result.StructuredContent)
	}
	return text
}

// jsonSchemaToParameters turns an MCP input schema into the parameter map a
// tool registration carries. The schema is JSON, and the parameters of a tool
// are read as JSON, so the schema is decoded and kept.
func jsonSchemaToParameters(schema json.RawMessage) map[string]any {
	if len(schema) == 0 {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	parameters := map[string]any{}
	if err := json.Unmarshal(schema, &parameters); err != nil {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	return parameters
}
