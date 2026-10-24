package graph

// The native tools the PiG kernel's session offers.
//
// The table is the set of tools; the rules about where they may write
// are here.
import (
	"path/filepath"
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
