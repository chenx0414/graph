package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// piExtensionManifestEntries reads the package's own `pi.extensions` list.
func piExtensionManifestEntries(packageRoot string) ([]string, error) {
	raw, err := os.ReadFile(filepath.Join(packageRoot, "package.json"))
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Pi struct {
			Extensions []string `json:"extensions"`
		} `json:"pi"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	entries := []string{}
	for _, entry := range manifest.Pi.Extensions {
		if entry == "" {
			continue
		}
		entries = append(entries, filepath.Join(packageRoot, entry))
	}
	return entries, nil
}

// piExtensionNpmInstallRoot is the SDK's temporary npm install root:
// `<agentDir>/tmp/extensions/npm/<sha256("npm-")[:8]>`.
func piExtensionNpmInstallRoot(agentDir string) string {
	base := filepath.Join(agentDir, "tmp", "extensions")
	if err := os.MkdirAll(base, 0o700); err == nil {
		_ = os.Chmod(base, 0o700)
	}
	sum := sha256.Sum256([]byte("npm-"))
	hash := hex.EncodeToString(sum[:])[:8]
	return filepath.Join(base, "npm", hash)
}

// piExtensionGitInstallPath is the SDK's temporary git install path.
func piExtensionGitInstallPath(parsed piExtensionSource, agentDir string) string {
	base := filepath.Join(agentDir, "tmp", "extensions")
	prefix := "git-" + parsed.host
	sum := sha256.Sum256([]byte(prefix + "-" + parsed.path))
	hash := hex.EncodeToString(sum[:])[:8]
	return filepath.Join(base, prefix, hash, filepath.Base(strings.TrimSuffix(parsed.path, ".git")))
}

// piExtensionEnsureNpmProject makes the install root an npm project, like the SDK does.
func piExtensionEnsureNpmProject(root string) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	manifest := filepath.Join(root, "package.json")
	if _, err := os.Stat(manifest); err == nil {
		return nil
	}
	body, err := json.MarshalIndent(map[string]any{"name": piExtensionInstallName, "private": true}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifest, body, 0o600)
}

// piExtensionInstallRootFor is the install root npm used for a temporary source:
// `<root>/node_modules/<pkg>/…`.
func piExtensionInstallRootFor(entry string) string {
	current := filepath.Dir(entry)
	for {
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		if filepath.Base(current) == "node_modules" {
			return parent
		}
		current = parent
	}
}

// piExtensionUnique keeps the first occurrence of every path.
func piExtensionUnique(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

// piExtensionPackageManifestAt is the nearest package.json at or above one path.
func piExtensionPackageManifestAt(start string) (map[string]any, bool) {
	current := start
	for {
		file := filepath.Join(current, "package.json")
		if _, err := os.Stat(file); err == nil {
			raw, err := os.ReadFile(file)
			if err != nil {
				return nil, false
			}
			var manifest map[string]any
			if err := json.Unmarshal(raw, &manifest); err != nil {
				return nil, false
			}
			return manifest, true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil, false
		}
		current = parent
	}
}
