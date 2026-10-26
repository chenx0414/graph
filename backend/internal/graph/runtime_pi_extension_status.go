package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// NpmSourceName is the package name inside an `npm:` source; nil for git and local sources.
func NpmSourceName(source string) *string {
	if !strings.HasPrefix(source, "npm:") {
		return nil
	}
	spec := strings.TrimSpace(strings.TrimPrefix(source, "npm:"))
	if spec == "" {
		return nil
	}
	at := strings.LastIndex(spec, "@")
	name := spec
	if at > 0 {
		name = spec[:at]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	return &name
}

// piExtensionPackageVersionAt is the version in the nearest package.json above an entry; `name`
// narrows which manifest counts.
func piExtensionPackageVersionAt(entry string, name *string) (*string, error) {
	directory := filepath.Dir(entry)
	for depth := 0; depth < 8; depth++ {
		candidate := filepath.Join(directory, "package.json")
		if _, err := os.Stat(candidate); err == nil {
			raw, err := os.ReadFile(candidate)
			if err == nil {
				var manifest struct {
					Name    string `json:"name"`
					Version string `json:"version"`
				}
				if json.Unmarshal(raw, &manifest) == nil {
					matches := name == nil || manifest.Name == *name
					if matches && manifest.Version != "" {
						version := manifest.Version
						return &version, nil
					}
				}
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return nil, nil
}

// piExtensionInstallRootOf is the install root npm wrote: the folder that owns the `node_modules`
// the entry lives in.
func piExtensionInstallRootOf(entry string) string {
	at := strings.Index(entry, string(filepath.Separator)+"node_modules"+string(filepath.Separator))
	if at > 0 {
		return entry[:at]
	}
	return ""
}

// piExtensionNpmLatest is the newest version the registry has for a spec.
func piExtensionNpmLatest(spec string, cwd string) *string {
	stdout, err := piExtensionRunCommand("npm", []string{"view", spec, "version", "--json"}, cwd, piExtensionQueryTimeout)
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return nil
	}
	var single string
	if json.Unmarshal([]byte(trimmed), &single) == nil && single != "" {
		return &single
	}
	var list []string
	if json.Unmarshal([]byte(trimmed), &list) == nil && len(list) > 0 {
		latest := list[len(list)-1]
		return &latest
	}
	return nil
}
