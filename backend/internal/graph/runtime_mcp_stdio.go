package graph

// An MCP server that runs as a child process.
//
// Its requests and replies travel over its standard streams.
import (
	"encoding/json"
	"strings"
)

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
