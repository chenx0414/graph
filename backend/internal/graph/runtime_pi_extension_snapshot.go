package graph

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// PackageGaps reports the relative paths a package declares as its own runtime entry points but
// does not have on disk.
//
// A truncated install — the incident this exists for: a package was present under `node_modules`
// while its whole `v4/` directory was missing, so the extension that needed it died with
// `Cannot find module './v4/classic/external.js'` — is invisible to a directory check, so completeness has to be
// checked per declared target. Type declarations are ignored here: a package may legitimately ship
// none, and a missing `.d.ts` never stops a load.
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
				// A subpath export ("./v4/classic/external.js") is a real file the package must ship; a
				// custom condition name ("standard-schema-spec") is not a runtime entry for us and may
				// legitimately point at sources the published package leaves out.
				subpath := strings.HasPrefix(key, ".")
				if !subpath && !piExtensionRuntimeConditions[key] {
					continue
				}
				// "." is the package's own root entry, not a subpath: a dependency only has to satisfy it.
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
		// `main` is often written without a `./` prefix (`ajv` ships `dist/ajv.js`, `cross-spawn`
		// ships `index.js`); only absolute paths and URLs are outside the package.
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

// piExtensionTargetExists applies the same resolution Node itself applies to a plain path: the
// exact file, the file with a runtime extension, or the directory's index. Declaring `main:
// "./index"` while shipping `index.js` is perfectly normal (`ms` does exactly that), and a gap check
// that called such a package broken would reinstall a healthy tree.
func piExtensionTargetExists(dir string, relative string) bool {
	for _, suffix := range []string{"", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs", "/index.cjs", "/index.json"} {
		if _, err := os.Stat(filepath.Join(dir, relative+suffix)); err == nil {
			return true
		}
	}
	return false
}

// InstallRootGaps reports every top-level package in one install root that declares an entry point
// it does not ship.
//
// Diagnostic only: neither a gap nor a snapshot difference proves damage — a published package may
// declare a root entry it never ships (`@modelcontextprotocol/sdk@1.30.1` declares
// `dist/esm/index.js` and the official tarball has no such file), and a change in that tree can be
// another source's legitimate update. The install root is shared by every temporary npm source, so
// resolving one source must never remove it.
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
