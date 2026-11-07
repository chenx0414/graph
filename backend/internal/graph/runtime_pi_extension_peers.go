package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const piExtensionInstallSnapshotFile = ".graph-install.json"

func piExtensionInstallTree(root string) (map[string]string, error) {
	nodeModules := filepath.Join(root, "node_modules")
	entries, err := os.ReadDir(nodeModules)
	if err != nil {
		return map[string]string{}, nil
	}
	tree := map[string]string{}
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
			files := []string{}
			err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return nil
				}
				if info.IsDir() {
					return nil
				}
				relative, relErr := filepath.Rel(dir, path)
				if relErr != nil {
					return nil
				}
				files = append(files, relative)
				return nil
			})
			if err != nil {
				return nil, err
			}
			sort.Strings(files)
			sum := sha256.Sum256([]byte(strings.Join(files, "\n")))
			tree[name] = hex.EncodeToString(sum[:])
		}
	}
	return tree, nil
}

func RecordInstallSnapshot(root string) error {
	tree, err := piExtensionInstallTree(root)
	if err != nil {
		return err
	}
	body, err := json.Marshal(tree)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, piExtensionInstallSnapshotFile), body, 0o600)
}

func EnsureRequiredPeers(entry string) error {
	root := piExtensionInstallRootFor(entry)
	if root == "" {
		return nil
	}
	manifest, ok := piExtensionPackageManifestAt(filepath.Dir(entry))
	if !ok {
		return nil
	}
	peers, _ := manifest["peerDependencies"].(map[string]any)
	meta, _ := manifest["peerDependenciesMeta"].(map[string]any)
	required := []string{}
	for name := range peers {
		if strings.HasPrefix(name, "@earendil-works/") {
			continue
		}
		if entryMeta, ok := meta[name].(map[string]any); ok {
			if optional, ok := entryMeta["optional"].(bool); ok && optional {
				continue
			}
		}
		required = append(required, name)
	}
	sort.Strings(required)
	if len(required) == 0 {
		return nil
	}
	broken := []string{}
	for _, name := range required {
		dir := filepath.Join(root, "node_modules", name)
		if _, err := os.Stat(dir); err != nil {
			broken = append(broken, name)
			continue
		}
		missing, err := PackageGaps(dir, false)
		if err != nil {
			return err
		}
		if len(missing) > 0 {
			broken = append(broken, name)
		}
	}
	if len(broken) == 0 {
		return nil
	}
	args := []string{"install"}
	for _, name := range broken {
		version, _ := peers[name].(string)
		args = append(args, name+"@"+version)
	}
	args = append(args, "--prefix", root, "--omit=dev", "--no-save", "--no-audit", "--no-fund", "--prefer-online")
	_, _ = piExtensionRunNpm(args[0], args[1:]...)
	return nil
}
