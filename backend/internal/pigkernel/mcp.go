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


type McpServerSpec struct {
	Name string
	Command string
	Args    []string
	Cwd     string
	Env map[string]string
	URL string
	Headers map[string]string
}

type mcpConnection struct {
	spec   McpServerSpec
	client *mcp.Client
}

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

func closeMcpServers(connections []*mcpConnection) {
	for _, connection := range connections {
		_ = connection.client.Close()
	}
}

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

func mcpToolName(server, tool string) string {
	return "mcp__" + mcpNamePart(server) + "__" + mcpNamePart(tool)
}

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
