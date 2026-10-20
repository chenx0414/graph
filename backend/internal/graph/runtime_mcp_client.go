package graph

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
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
type StdioEndpoint struct {
	Executor interface {
		Run(command RestrictedCommand) McpRunResult
	}
	Gate                      RestrictedGate
	Cwd                       string
	ScratchDir                string
	Command                   string
	Args                      []string
	Env                       map[string]string
	ReadPaths                 []string
	WritePaths                []string
	TimeoutMs                 *int
	NetworkDomains            []string
	AllowUnrestrictedNetwork  bool
	AllowGitMetadataWrites    []string
	AllowGitMetadataWritesAll bool
	AllowLocalBinding         bool
	AllowAllUnixSockets       bool
	AllowAppleEvents          bool
	Filesystem                string
	ProtectedPaths            []string
	ProtectedPathExceptions   []string
}

// HttpEndpoint is a remote Streamable HTTP MCP server.
type HttpEndpoint struct {
	Gate      RestrictedGate
	Url       string
	Headers   map[string]string
	TimeoutMs *int
}

// McpRunResult is the restricted executor reply.
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
func StdioExchange(endpoint StdioEndpoint) McpExchange {
	return stdioMcp{endpoint: endpoint}
}

type stdioMcp struct{ endpoint StdioEndpoint }

func (exchange stdioMcp) Exchange(requests []any, expect int) McpReply {
	reply, _ := usageSettled(exchange.endpoint.Gate, func() any {
		var streamed *McpReply
		var process *McpProcessControl
		pending := ""
		timeout := 30000
		if exchange.endpoint.TimeoutMs != nil {
			timeout = *exchange.endpoint.TimeoutMs
		}
		command := RestrictedCommand{
			Broker: exchange.endpoint.Gate, Cwd: exchange.endpoint.Cwd, ScratchDir: exchange.endpoint.ScratchDir,
			Executable: exchange.endpoint.Command, Args: exchange.endpoint.Args,
			ReadPaths: exchange.endpoint.ReadPaths, WritePaths: exchange.endpoint.WritePaths,
			TimeoutMs: timeout, KeepStdinOpen: true,
			Input: mcpJoinRequests(requests),
		}
		if len(exchange.endpoint.Env) > 0 {
			command.Env = exchange.endpoint.Env
		}
		if len(exchange.endpoint.NetworkDomains) > 0 {
			command.NetworkDomains = exchange.endpoint.NetworkDomains
		}
		if exchange.endpoint.AllowUnrestrictedNetwork {
			command.AllowUnrestrictedNetwork = true
		}
		if len(exchange.endpoint.AllowGitMetadataWrites) > 0 {
			command.AllowGitMetadataWrites = exchange.endpoint.AllowGitMetadataWrites
		}
		if exchange.endpoint.AllowGitMetadataWritesAll {
			command.AllowGitMetadataWritesAll = true
		}
		if exchange.endpoint.AllowLocalBinding {
			command.AllowLocalBinding = true
		}
		if exchange.endpoint.AllowAllUnixSockets {
			command.AllowAllUnixSockets = true
		}
		if exchange.endpoint.AllowAppleEvents {
			command.AllowAppleEvents = true
		}
		if exchange.endpoint.Filesystem != "" {
			command.Filesystem = exchange.endpoint.Filesystem
		}
		if len(exchange.endpoint.ProtectedPaths) > 0 {
			command.ProtectedPaths = exchange.endpoint.ProtectedPaths
		}
		if len(exchange.endpoint.ProtectedPathExceptions) > 0 {
			command.ProtectedPathExceptions = exchange.endpoint.ProtectedPathExceptions
		}
		command.OnSpawn = func(control McpProcessControl) { process = &control }
		command.OnStdout = func(chunk string) {
			pending += chunk
			for {
				newline := strings.IndexByte(pending, '\n')
				if newline < 0 {
					return
				}
				line := pending[:newline]
				pending = pending[newline+1:]
				if strings.TrimSpace(line) == "" {
					continue
				}
				message, ok := mcpParseReply(line)
				if ok && mcpIdEqual(message.Id, expect) {
					copy := message
					streamed = &copy
					if process != nil {
						process.End()
					}
				}
			}
		}
		result := exchange.endpoint.Executor.Run(command)
		replies := map[int]McpReply{}
		for _, line := range strings.Split(result.Stdout, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			message, ok := mcpParseReply(line)
			if !ok {
				continue
			}
			if number, ok := mcpNumberId(message.Id); ok {
				replies[number] = message
			}
		}
		if (result.Code == nil || *result.Code != 0) && len(replies) == 0 {
			stderr := strings.TrimSpace(result.Stderr)
			if stderr == "" {
				code := "null"
				if result.Code != nil {
					code = itoa(*result.Code)
				}
				stderr = "MCP server exited with code " + code
			}
			Raise("capability_failed", stderr)
		}
		if streamed != nil {
			return *streamed
		}
		reply, ok := replies[expect]
		if !ok {
			Raise("capability_failed", "MCP server did not answer request "+itoa(expect))
		}
		return reply
	}).(McpReply)
	return reply
}

func mcpJoinRequests(requests []any) string {
	lines := make([]string, 0, len(requests))
	for _, request := range requests {
		encoded, err := json.Marshal(request)
		if err != nil {
			panic(err)
		}
		lines = append(lines, string(encoded))
	}
	return strings.Join(lines, "\n") + "\n"
}

// HttpExchange talks to a remote MCP server and refuses redirects.
func HttpExchange(endpoint HttpEndpoint) McpExchange {
	return httpMcp{endpoint: endpoint}
}

type httpMcp struct{ endpoint HttpEndpoint }

func (exchange httpMcp) Exchange(requests []any, expect int) McpReply {
	timeout := 30000
	if exchange.endpoint.TimeoutMs != nil {
		timeout = *exchange.endpoint.TimeoutMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()
	session := map[string]string{}
	var reply *McpReply
	for _, request := range requests {
		response := gatedRequest(exchange.endpoint.Gate, func() any {
			return mcpPost(ctx, exchange.endpoint, session, request)
		}).(*http.Response)
		if id := response.Header.Get("mcp-session-id"); id != "" {
			session["mcp-session-id"] = id
		}
		if response.StatusCode == 202 || response.StatusCode == 204 {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			response.Body.Close()
			Raise("capability_failed", "Remote MCP answered HTTP "+itoa(response.StatusCode))
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 2_000_001))
		response.Body.Close()
		if err != nil {
			panic(err)
		}
		if len(body) > 2_000_000 {
			Raise("capability_failed", "Remote MCP response exceeded the size bound")
		}
		if strings.TrimSpace(string(body)) == "" {
			continue
		}
		for _, message := range parseHttpBody(string(body), response.Header.Get("content-type")) {
			if mcpIdEqual(message.Id, expect) {
				copy := message
				reply = &copy
			}
		}
	}
	if reply == nil {
		Raise("capability_failed", "Remote MCP did not answer request "+itoa(expect))
	}
	if reply.Error != nil {
		message := "Remote MCP error"
		if reply.Error.Message != nil {
			message = *reply.Error.Message
		}
		Raise("capability_failed", message)
	}
	if _, ok := reply.raw["result"]; !ok {
		Raise("capability_failed", "Remote MCP returned no result for request "+itoa(expect))
	}
	return *reply
}

func mcpPost(ctx context.Context, endpoint HttpEndpoint, session map[string]string, request any) *http.Response {
	encoded, err := json.Marshal(request)
	if err != nil {
		panic(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.Url, bytes.NewReader(encoded))
	if err != nil {
		panic(err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	for key, value := range endpoint.Headers {
		req.Header.Set(key, value)
	}
	for key, value := range session {
		req.Header.Set(key, value)
	}
	client := &http.Client{
		Timeout:   0,
		Transport: HTTPClient.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not allowed")
		},
	}
	response, err := client.Do(req)
	if err != nil {
		panic(err)
	}
	return response
}

func parseHttpBody(body, contentType string) []McpReply {
	if strings.Contains(contentType, "text/event-stream") {
		replies := []McpReply{}
		for _, line := range strings.Split(body, "\n") {
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(line[5:])
			if data == "" || data == "[DONE]" {
				continue
			}
			if message, ok := mcpParseReply(data); ok {
				replies = append(replies, message)
			}
		}
		return replies
	}
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "[") {
		var list []map[string]any
		if err := json.Unmarshal([]byte(body), &list); err != nil {
			panic(err)
		}
		out := make([]McpReply, 0, len(list))
		for _, item := range list {
			out = append(out, mcpReplyFromMap(item))
		}
		return out
	}
	message, ok := mcpParseReply(body)
	if !ok {
		panic(errors.New("Remote MCP response was not JSON"))
	}
	return []McpReply{message}
}

func requireMcpResult(reply McpReply, expect int) McpReply {
	if reply.Error != nil {
		message := "MCP server error"
		if reply.Error.Message != nil {
			message = *reply.Error.Message
		}
		Raise("capability_failed", message)
	}
	if _, ok := reply.raw["result"]; !ok {
		Raise("capability_failed", "MCP server returned no result for request "+itoa(expect))
	}
	return reply
}

// ListMcpTools initializes a server and reads tools/list.
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
