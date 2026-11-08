package graph

import (
	"path/filepath"

	"errors"
)

var PigNativeToolNames = []string{"read", "write", "edit", "ls", "find", "grep", "bash"}

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
	hostRead := true
	hostWrite := true
	options := BoundedPathOptions{
		AllowGitMetadata:             true,
		ProtectedPaths:               nil,
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

func pigNativeNumber(value any) int {
	number, ok := agentToolsNumber(value)
	if !ok {
		return 0
	}
	return int(number)
}

func writeExceptionsOf(root string, hostWrite bool) []string {
	if !hostWrite {
		return []string{}
	}
	return []string{root}
}

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
