package graph

import (
	"path/filepath"
	"strings"

	"errors"
)

// agentToolsWorkspaceHandlers are the handlers of the Workspace tools.
func agentToolsWorkspaceHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"read": func(id string, params map[string]any) any {
			requested := agentToolsString(params["path"])
			mimeType := agentToolsImageMimeType(requested)
			if filepath.IsAbs(requested) {
				if hostRead {
					if mimeType != "" {
						return agentToolsImage(ReadHostBytes(requested, pathOptions), mimeType)
					}
					return agentToolsText(ReadHost(requested, pathOptions))
				}
				mount := agentToolsMount(append([]string{root}, readRoots...), requested)
				if mount == "" {
					panic(errors.New("Path is outside the workspace"))
				}
				if mimeType != "" {
					return agentToolsImage(ReadBoundedBytes(mount, requested), mimeType)
				}
				return agentToolsText(ReadBounded(mount, requested))
			}
			if mimeType != "" {
				return agentToolsImage(ReadBoundedBytes(root, requested), mimeType)
			}
			return agentToolsText(ReadBounded(root, requested))
		},
		"write_file": func(id string, params map[string]any) any {
			requested := agentToolsString(params["path"])
			capture := func(side string) {
				if input.WriteLedger == nil || input.WriteLedger.Ledger == nil {
					return
				}
				defer func() { _ = recover() }()
				input.WriteLedger.Ledger.Capture(side, WriteCaptureInput{
					TaskID: input.WriteLedger.TaskId, NodeID: input.WriteLedger.NodeId,
					InstanceID: input.WriteLedger.InstanceId, TurnID: input.WriteLedger.TurnId,
					ToolCallID: id, ToolName: "write_file", Path: requested, Workspace: root,
				})
			}
			capture("open")
			content := agentToolsString(params["content"])
			if hostWrite && filepath.IsAbs(requested) {
				WriteHost(requested, content, pathOptions)
			} else {
				WriteBounded(root, requested, content)
			}
			capture("close")
			return agentToolsText("Wrote " + agentToolsString(params["path"]))
		},
		"list_dir": func(id string, params map[string]any) any {
			requested := "."
			if agentToolsTruthy(params["path"]) {
				requested = agentToolsString(params["path"])
			}
			if filepath.IsAbs(requested) {
				if hostRead {
					return agentToolsText(strings.Join(ListHost(requested, pathOptions), "\n"))
				}
				mount := agentToolsMount(append([]string{root}, readRoots...), requested)
				if mount == "" {
					panic(errors.New("Path is outside the workspace"))
				}
				return agentToolsText(strings.Join(ListBounded(mount, requested), "\n"))
			}
			return agentToolsText(strings.Join(ListBounded(root, requested), "\n"))
		},
		"workspace_commit": func(id string, params map[string]any) any {
			raw, ok := params["paths"].([]any)
			message, messageIsString := params["message"].(string)
			if !ok || !messageIsString {
				Raise("invalid_input", "workspace_commit requires paths and message")
			}
			paths := []string{}
			for _, item := range raw {
				path, isString := item.(string)
				if !isString {
					Raise("invalid_input", "workspace_commit requires paths and message")
				}
				paths = append(paths, path)
			}
			return agentToolsText(stringifyJSON(input.CommitWorkspace(paths, message)))
		},
		"run_command": func(id string, params map[string]any) any {
			args := []string{}
			if raw, ok := params["args"].([]any); ok {
				for _, item := range raw {
					args = append(args, agentToolsString(item))
				}
			}
			result := input.Run(agentToolsString(params["command"]), args, nil)
			return agentToolsText(agentToolsCommandOutput(result))
		},
		"git": func(id string, params map[string]any) any {
			subcommand := strings.TrimSpace(agentToolsStringOrEmpty(params["subcommand"]))
			if !agentToolsContains(agentToolsGitReadSubcommands, subcommand) {
				panic(errors.New("Only read-only git subcommands: " + strings.Join(agentToolsGitReadSubcommands, ", ")))
			}
			args := []string{}
			if raw, ok := params["args"].([]any); ok {
				for _, item := range raw {
					args = append(args, agentToolsString(item))
				}
			}
			for _, value := range args {
				if len(value) > 200 || strings.ContainsAny(value, "\x00\r\n") {
					panic(errors.New("Invalid git argument"))
				}
			}
			for _, value := range args {
				if value == "--output" || strings.HasPrefix(value, "--exec") || strings.HasPrefix(value, "--no-index") {
					panic(errors.New("Unsupported git argument"))
				}
			}
			path := ""
			if raw, ok := params["path"].(string); ok {
				path = strings.TrimSpace(raw)
			}
			if path != "" && (strings.HasPrefix(path, "-") || strings.ContainsAny(path, "\x00\r\n")) {
				panic(errors.New("Invalid git path"))
			}
			base := append([]string{subcommand}, args...)
			full := agentToolsGitText(input, base, path)
			if len(full) <= agentToolsGitOutputLimit {
				return agentToolsText(full)
			}
			summary := agentToolsGitText(input, append([]string{subcommand, "--stat"}, args...), path)
			if len(summary) > agentToolsGitOutputLimit {
				summary = summary[:agentToolsGitOutputLimit]
			}
			return agentToolsText("output exceeded " + itoa(agentToolsGitOutputLimit) + " characters; --stat summary follows\n\n" + summary)
		},
		"fetch": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Fetch(agentToolsString(params["url"]), nil)))
		},
	}
}
