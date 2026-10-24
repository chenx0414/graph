package graph

// The MCP client: how the daemon talks to an MCP server.
//
// The handshake, the calls, and the replies are here.
import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// McpTool is one tool a server listed.

type McpTool struct {
	Name        string
	Description *string
	InputSchema any
}

// McpReply is one JSON-RPC response.

type McpReply struct {
	Id     any
	Result any
	Error  *struct {
		Message *string
	}
	raw map[string]any
}

// McpExchange is one JSON-RPC exchange through the send gate.

type McpExchange interface {
	Exchange(requests []any, expect int) McpReply
}

// StdioEndpoint is one sandboxed process per exchange.

type McpRunResult struct {
	Code   *int
	Stdout string
	Stderr string
}

// McpProcessControl is the host's view of a spawned MCP process.

type McpProcessControl struct {
	Kill func(signal string) bool
	End  func()
}

var mcpArgPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func mcpHandshake() []any {
	return []any{
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "graph", "version": "0.0.0"}}},
		map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
	}
}

func mcpZeroUsage() *TokenUsage {
	return &TokenUsage{}
}

func usageSettled(gate RestrictedGate, run func() any) any {
	invocationId := graphUUID()
	var failure any
	var value any
	gate.Dispatch(invocationId, 0, func() any {
		defer func() {
			if recovered := recover(); recovered != nil {
				failure = recovered
			}
			gate.Settle(invocationId, mcpZeroUsage())
		}()
		value = run()
		return nil
	})
	if failure != nil {
		panic(failure)
	}
	return value
}

// gatedRequest checks the gate in the same turn as the send.

func gatedRequest(gate RestrictedGate, send func() any) any {
	invocationId := graphUUID()
	sent := false
	defer func() {
		if sent {
			gate.Settle(invocationId, mcpZeroUsage())
		}
	}()
	return gate.Dispatch(invocationId, 0, func() any {
		sent = true
		return send()
	})
}

// StdioExchange runs one OS-restricted process for the exchange.

func ListMcpTools(connection McpExchange) []McpTool {
	requests := append(mcpHandshake(), map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{}})
	reply := requireMcpResult(connection.Exchange(requests, 2), 2)
	result, _ := reply.Result.(map[string]any)
	tools, _ := result["tools"].([]any)
	if result == nil || tools == nil && result["tools"] != nil {
		Raise("capability_failed", "MCP server did not list tools")
	}
	if _, ok := result["tools"]; !ok || tools == nil && result["tools"] != nil {
		Raise("capability_failed", "MCP server did not list tools")
	}
	if tools == nil {
		if _, isArray := result["tools"].([]any); !isArray {
			Raise("capability_failed", "MCP server did not list tools")
		}
	}
	out := make([]McpTool, 0, len(tools))
	for _, tool := range tools {
		value, _ := tool.(map[string]any)
		name, _ := value["name"].(string)
		if strings.TrimSpace(name) == "" {
			Raise("capability_failed", "MCP tool is missing a name")
		}
		item := McpTool{Name: name}
		if description, ok := value["description"].(string); ok {
			item.Description = &description
		}
		if schema, ok := value["inputSchema"]; ok && schema != nil {
			item.InputSchema = schema
		}
		out = append(out, item)
	}
	return out
}

// CallMcpTool initializes a server and calls one tool.

func CallMcpTool(connection McpExchange, name string, args any) struct {
	Content []struct {
		Type string
		Text string
	}
	IsError bool
} {
	requests := append(mcpHandshake(), map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	reply := requireMcpResult(connection.Exchange(requests, 2), 2)
	result, _ := reply.Result.(map[string]any)
	content := []struct {
		Type string
		Text string
	}{}
	if parts, ok := result["content"].([]any); ok {
		for _, part := range parts {
			value, _ := part.(map[string]any)
			text, ok := value["text"].(string)
			if !ok {
				encoded, err := json.Marshal(value)
				if err != nil {
					panic(err)
				}
				text = string(encoded)
			}
			content = append(content, struct {
				Type string
				Text string
			}{Type: "text", Text: text})
		}
	}
	isError, _ := result["isError"].(bool)
	return struct {
		Content []struct {
			Type string
			Text string
		}
		IsError bool
	}{Content: content, IsError: isError}
}

// ResolveMcpArg expands ${VAR} references and relative paths in a manifest argument.

func ResolveMcpArg(snapshot, value string, env map[string]string) string {
	expanded := mcpArgPattern.ReplaceAllStringFunc(value, func(match string) string {
		name := mcpArgPattern.FindStringSubmatch(match)[1]
		if env != nil {
			if resolved, ok := env[name]; ok {
				return resolved
			}
		}
		resolved, ok := os.LookupEnv(name)
		if !ok {
			Raise("capability_unavailable", "MCP manifest requires environment variable "+name)
		}
		return resolved
	})
	if strings.HasPrefix(expanded, "./") || strings.HasPrefix(expanded, "../") {
		resolved, err := filepath.Abs(filepath.Join(snapshot, expanded))
		if err != nil {
			panic(err)
		}
		return resolved
	}
	return expanded
}

func mcpParseReply(line string) (McpReply, bool) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return McpReply{}, false
	}
	return mcpReplyFromMap(raw), true
}

func mcpReplyFromMap(raw map[string]any) McpReply {
	reply := McpReply{Id: raw["id"], Result: raw["result"], raw: raw}
	if errValue, ok := raw["error"].(map[string]any); ok {
		item := struct{ Message *string }{}
		if message, ok := errValue["message"].(string); ok {
			item.Message = &message
		}
		reply.Error = &item
	}
	return reply
}

func mcpNumberId(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		if typed == float64(int(typed)) {
			return int(typed), true
		}
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case json.Number:
		number, err := typed.Int64()
		if err == nil {
			return int(number), true
		}
	}
	return 0, false
}

func mcpIdEqual(value any, expect int) bool {
	number, ok := mcpNumberId(value)
	return ok && number == expect
}
