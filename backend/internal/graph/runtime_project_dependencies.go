package graph

import (
	"os"
	"path/filepath"
)

// LinkProjectDependencies links the project's installed toolchain into a work copy.
// The returned path is the sandbox read grant. A missing candidate yields no path.
func LinkProjectDependencies(workspace string, candidate *string) *string {
	if candidate == nil || *candidate == "" {
		return nil
	}
	modules, err := filepath.EvalSymlinks(*candidate)
	if err != nil {
		return nil
	}
	link := filepath.Join(workspace, "node_modules")
	if _, err := os.Stat(link); os.IsNotExist(err) {
		_ = os.Symlink(modules, link)
	}
	return &modules
}
