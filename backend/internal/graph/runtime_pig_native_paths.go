package graph

// The paths the native tools are allowed to reach.
//
// Every path a tool is given goes through here first.
import (
	"errors"
	"path/filepath"
)

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
	if filepath.IsAbs(requested) {
		if paths.hostRead {
			return ListHost(requested, paths.options)
		}
		mount := agentToolsMount(append([]string{paths.root}, paths.readRoots...), requested)
		if mount == "" {
			panic(errors.New("Path is outside the workspace"))
		}
		return ListBounded(mount, requested)
	}
	return ListBounded(paths.root, requested)
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
