package graph

import (
	"path/filepath"

	"errors"
)

type pigNativePaths struct {
	root      string
	readRoots []string
	hostRead  bool
	hostWrite bool
	options   BoundedPathOptions
}

func (paths *pigNativePaths) readText(requested string) string {
	return string(paths.readBytes(requested))
}

func (paths *pigNativePaths) readBytes(requested string) []byte {
	if filepath.IsAbs(requested) {
		if paths.hostRead {
			return ReadHostBytes(requested, paths.options)
		}
		mount := agentToolsMount(append([]string{paths.root}, paths.readRoots...), requested)
		if mount == "" {
			panic(errors.New("Path is outside the workspace"))
		}
		return ReadBoundedBytes(mount, requested)
	}
	return ReadBoundedBytes(paths.root, requested)
}

func (paths *pigNativePaths) writeText(requested, content string) {
	if paths.hostWrite && filepath.IsAbs(requested) {
		WriteHost(requested, content, paths.options)
		return
	}
	WriteBounded(paths.root, requested, content)
}

func (paths *pigNativePaths) listNames(requested string) []string {
	names, _ := paths.listNamesLimited(requested, 0)
	return names
}

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
