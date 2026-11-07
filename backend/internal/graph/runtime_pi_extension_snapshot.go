package graph

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

func PackageGaps(dir string, rootOnly bool) ([]string, error) {
	manifest, ok := piExtensionPackageManifestAt(dir)
	if !ok {
		return []string{"package.json"}, nil
	}
	targets := map[string]bool{}
	var collect func(value any)
	collect = func(value any) {
		switch typed := value.(type) {
		case string:
			if !strings.Contains(typed, "*") && !piExtensionDeclarationPattern.MatchString(typed) {
				targets[typed] = true
			}
			return
		case []any:
			for _, item := range typed {
				collect(item)
			}
			return
		case map[string]any:
			for key, item := range typed {
				subpath := strings.HasPrefix(key, ".")
				if !subpath && !piExtensionRuntimeConditions[key] {
					continue
				}
				if rootOnly && subpath && key != "." {
					continue
				}
				collect(item)
			}
		}
	}
	collect(manifest["main"])
	collect(manifest["module"])
	collect(manifest["exports"])
	ordered := make([]string, 0, len(targets))
	for target := range targets {
		ordered = append(ordered, target)
	}
	sort.Strings(ordered)
	gaps := []string{}
	for _, target := range ordered {
		if strings.HasPrefix(target, "/") || piExtensionURLPattern.MatchString(target) {
			continue
		}
		relative := strings.TrimPrefix(target, "./")
		if !piExtensionTargetExists(dir, relative) {
			gaps = append(gaps, relative)
		}
	}
	return gaps, nil
}

var piExtensionURLPattern = regexp.MustCompile(`^[a-zA-Z]+:`)

func piExtensionTargetExists(dir string, relative string) bool {
	for _, suffix := range []string{"", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs", "/index.cjs", "/index.json"} {
		if _, err := os.Stat(filepath.Join(dir, relative+suffix)); err == nil {
			return true
		}
	}
	return false
}

func InstallRootGaps(root string) ([]string, error) {
	nodeModules := filepath.Join(root, "node_modules")
	entries, err := os.ReadDir(nodeModules)
	if err != nil {
		return []string{}, nil
	}
	gaps := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		names := []string{entry.Name()}
		if strings.HasPrefix(entry.Name(), "@") {
			scoped, err := os.ReadDir(filepath.Join(nodeModules, entry.Name()))
			if err != nil {
				continue
			}
			names = names[:0]
			for _, item := range scoped {
				names = append(names, entry.Name()+"/"+item.Name())
			}
		}
		for _, name := range names {
			dir := filepath.Join(nodeModules, name)
			missing, err := PackageGaps(dir, true)
			if err != nil {
				return nil, err
			}
			if len(missing) > 0 {
				gaps = append(gaps, name+": "+strings.Join(missing, ", "))
			}
		}
	}
	return gaps, nil
}
