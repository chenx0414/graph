package graph

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// The native tool surface of the PiG kernel.
//
// The TypeScript SDK owned the native tools - read, write, edit, ls, find,
// grep and the shell - and ran them inside the SDK's sandbox. The PiG kernel
// owns no environment of its own, so the daemon provides the same tools in
// Go: the same names, the same declarations and the same path rules the
// Graph already enforces for its own tools.
//
// Without this bridge the model would lose the file tools entirely: the Graph
// tool surface drops the tools a native tool supersedes, and on the PiG
// kernel nothing would take their place.

// PigNativeToolNames are the native tools the daemon provides in Go.
var PigNativeToolNames = []string{"read", "write", "edit", "ls", "find", "grep", "bash"}

// PigNativeTools builds the native tools one PiG session may call.
//
// The names are the SDK's own, so the model's prompt, its habits and its
// tool declarations stay the ones it already knows.
func PigNativeTools(input AgentToolsInput, granted []string) []ToolDefinition {
	root, err := filepath.EvalSymlinks(input.Workspace)
	if err != nil {
		panic(err)
	}
	readRoots := []string{}
	for _, item := range input.ReadRoots {
		resolved, err := filepath.EvalSymlinks(item)
		if err != nil {
			panic(err)
		}
		readRoots = append(readRoots, resolved)
	}
	hostRead := IsHostRead(input.Access)
	hostWrite := IsHostWrite(input.Access)
	options := BoundedPathOptions{
		AllowGitMetadata:             input.Access != nil && input.Access.Filesystem.GitMetadata == "writable",
		ProtectedPaths:               protectedPathsOf(input.Access),
		ProtectedReadPathExceptions:  agentToolsUnique(append([]string{root}, readRoots...)),
		ProtectedWritePathExceptions: writeExceptionsOf(root, hostWrite),
	}
	paths := &pigNativePaths{root: root, readRoots: readRoots, hostRead: hostRead, hostWrite: hostWrite, options: options}
	tools := []ToolDefinition{}
	for _, name := range granted {
		switch name {
		case "read":
			tools = append(tools, pigReadTool(paths))
		case "write":
			tools = append(tools, pigWriteTool(paths))
		case "edit":
			tools = append(tools, pigEditTool(paths))
		case "ls":
			tools = append(tools, pigLsTool(paths))
		case "find":
			tools = append(tools, pigFindTool(paths))
		case "grep":
			tools = append(tools, pigGrepTool(paths))
		case "bash":
			tools = append(tools, pigBashTool(input))
		}
	}
	return tools
}

// pigNativeNumber reads one optional number of a native tool's arguments.
func pigNativeNumber(value any) int {
	number, ok := agentToolsNumber(value)
	if !ok {
		return 0
	}
	return int(number)
}

// protectedPathsOf reads the paths the host protects.
func protectedPathsOf(access *ResolvedAccessPolicy) []string {
	if access == nil {
		return nil
	}
	return access.ProtectedPaths
}

// writeExceptionsOf reads the paths a write may reach beside the workspace.
func writeExceptionsOf(root string, hostWrite bool) []string {
	if !hostWrite {
		return []string{}
	}
	return []string{root}
}

// pigNativePaths resolves the paths the native tools may reach.
type pigNativePaths struct {
	root      string
	readRoots []string
	hostRead  bool
	hostWrite bool
	options   BoundedPathOptions
}

// readText reads one file the native tools may reach.
func (paths *pigNativePaths) readText(requested string) string {
	if filepath.IsAbs(requested) {
		if paths.hostRead {
			return ReadHost(requested, paths.options)
		}
		mount := agentToolsMount(append([]string{paths.root}, paths.readRoots...), requested)
		if mount == "" {
			panic(errors.New("Path is outside the workspace"))
		}
		return ReadBounded(mount, requested)
	}
	return ReadBounded(paths.root, requested)
}

// writeText writes one file the native tools may reach.
func (paths *pigNativePaths) writeText(requested, content string) {
	if paths.hostWrite && filepath.IsAbs(requested) {
		WriteHost(requested, content, paths.options)
		return
	}
	WriteBounded(paths.root, requested, content)
}

// listNames lists one directory the native tools may reach.
func (paths *pigNativePaths) listNames(requested string) []string {
	names, _ := paths.listNamesLimited(requested, 0)
	return names
}

// listNamesLimited lists one directory the native tools may reach, up to a
// limit. The second answer says whether the directory holds more entries
// than were returned.
func (paths *pigNativePaths) listNamesLimited(requested string, limit int) ([]string, bool) {
	if filepath.IsAbs(requested) {
		if paths.hostRead {
			return ListHostLimit(requested, paths.options, limit)
		}
		mount := agentToolsMount(append([]string{paths.root}, paths.readRoots...), requested)
		if mount == "" {
			panic(errors.New("Path is outside the workspace"))
		}
		return ListBoundedLimit(mount, requested, limit)
	}
	return ListBoundedLimit(paths.root, requested, limit)
}

// walkRoot is the directory the native file search starts from.
func (paths *pigNativePaths) walkRoot(requested string) string {
	if requested == "" {
		requested = "."
	}
	if filepath.IsAbs(requested) {
		if paths.hostRead {
			return requested
		}
		mount := agentToolsMount(append([]string{paths.root}, paths.readRoots...), requested)
		if mount == "" {
			panic(errors.New("Path is outside the workspace"))
		}
		return mount
	}
	return paths.root
}

// pigReadTool is the SDK's read tool.
func pigReadTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "read",
		Label:       "Read file",
		Description: "Read a UTF-8 file from the instance workspace or a bound capability. The answer is truncated to 2000 lines or 50KB, whichever comes first; use offset to continue.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "The file to read."},
				"offset": map[string]any{"type": "number", "description": "The first line to return, counted from 1."},
				"limit":  map[string]any{"type": "number", "description": "How many lines to return."},
			},
			"required": []any{"path"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := agentToolsString(arguments["path"])
			if requested == "" {
				return nil, errors.New("read needs a path")
			}
			text := paths.readText(requested)
			offset := pigNativeNumber(arguments["offset"])
			limit := pigNativeNumber(arguments["limit"])
			return agentToolsText(pigNativeReadText(text, offset, limit)), nil
		},
	}
}

// pigWriteTool is the SDK's write tool.
func pigWriteTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "write",
		Label:       "Write file",
		Description: "Create or overwrite files.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "The file to write."},
				"content": map[string]any{"type": "string", "description": "The content of the file."},
			},
			"required": []any{"path", "content"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := agentToolsString(arguments["path"])
			if requested == "" {
				return nil, errors.New("write needs a path")
			}
			paths.writeText(requested, agentToolsString(arguments["content"]))
			return agentToolsText("Wrote " + requested), nil
		},
	}
}

// pigEditTool is the SDK's edit tool.
//
// An edit replaces an exact text. Every replacement must match exactly once:
// an ambiguous replacement is refused rather than guessed.
func pigEditTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "edit",
		Label:       "Edit file",
		Description: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "The file to edit."},
				"edits": map[string]any{
					"type":        "array",
					"description": "The replacements to apply, in order.",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"oldText": map[string]any{"type": "string", "description": "The text to replace."},
							"newText": map[string]any{"type": "string", "description": "The text to write instead."},
						},
						"required": []any{"oldText", "newText"},
					},
				},
			},
			"required": []any{"path", "edits"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := agentToolsString(arguments["path"])
			if requested == "" {
				return nil, errors.New("edit needs a path")
			}
			edits, _ := arguments["edits"].([]any)
			if len(edits) == 0 {
				return nil, errors.New("edit needs at least one replacement")
			}
			text := paths.readText(requested)
			for _, item := range edits {
				edit := agentToolsParams(item)
				oldText := agentToolsString(edit["oldText"])
				newText := agentToolsString(edit["newText"])
				if oldText == "" {
					return nil, errors.New("An edit needs the text to replace")
				}
				if strings.Count(text, oldText) != 1 {
					return nil, fmt.Errorf("The text to replace occurs %d times in %s; it must occur exactly once", strings.Count(text, oldText), requested)
				}
				text = strings.Replace(text, oldText, newText, 1)
			}
			paths.writeText(requested, text)
			return agentToolsText("Edited " + requested), nil
		},
	}
}

// pigLsTool is the SDK's ls tool.
func pigLsTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "ls",
		Label:       "List directory",
		Description: "List directory contents. The listing is truncated to 500 entries or 50KB, whichever comes first.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":  map[string]any{"type": "string", "description": "The directory to list."},
				"limit": map[string]any{"type": "number", "description": "How many entries to return."},
			},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := "."
			if agentToolsTruthy(arguments["path"]) {
				requested = agentToolsString(arguments["path"])
			}
			limit := pigNativeLimit(arguments["limit"], pigNativeLsLimit)
			names, more := paths.listNamesLimited(requested, limit)
			notices := []string{}
			if more {
				notices = append(notices, fmt.Sprintf("%d entries limit reached. Use limit=%d for more", limit, limit*2))
			}
			return agentToolsText(pigNativeRender(names, notices)), nil
		},
	}
}

// pigNativePattern turns a shell-style pattern into a regular expression.
//
// The SDK's find and grep take a glob, not a regular expression, so `*` and
// `?` mean what they mean in a file name.
func pigNativePattern(pattern string) string {
	out := []rune{}
	for index, character := range pattern {
		switch character {
		case '*':
			out = append(out, []rune(".*")...)
		case '?':
			out = append(out, '.')
		case '.', '+', '(', ')', '|', '{', '}', '[', ']', '^', '$', '\\':
			out = append(out, '\\', character)
		default:
			out = append(out, character)
		}
		_ = index
	}
	return string(out)
}

// pigBashTool is the SDK's shell tool.
//
// The command runs through the Graph's own command runner, so it passes the
// same sandbox, the same policy and the same gate as every other command the
// Graph runs.
func pigBashTool(input AgentToolsInput) ToolDefinition {
	return ToolDefinition{
		Name:        "bash",
		Label:       "Run command",
		Description: "Execute bash commands (ls, grep, find, etc.)",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string", "description": "The command to run."},
				"timeout": map[string]any{"type": "number", "description": "How long the command may run, in milliseconds."},
			},
			"required": []any{"command"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			command := agentToolsString(arguments["command"])
			if command == "" {
				return nil, errors.New("bash needs a command")
			}
			if input.Run == nil {
				return nil, errors.New("This Agent may not run commands")
			}
			result := input.Run("sh", []string{"-c", command}, nil)
			return agentToolsText(agentToolsCommandOutput(result)), nil
		},
	}
}
