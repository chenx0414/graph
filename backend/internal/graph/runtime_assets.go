package graph

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/chenx0414/graph/backend/internal/graph/embedded"
)

var assetCacheDirOverride string

func assetCacheDir() string {
	if assetCacheDirOverride != "" {
		return assetCacheDirOverride
	}
	if daemonGraphHome != "" {
		return filepath.Join(daemonGraphHome, "assets")
	}
	return filepath.Join(GraphHome(), "assets")
}

func declaredAssets(parts ...string) string {
	root := GraphApplicationRoot()
	path := filepath.Join(append([]string{root}, parts...)...)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return ""
	}
	return path
}

func declaredAssetDir(parts ...string) string {
	root := GraphApplicationRoot()
	path := filepath.Join(append([]string{root}, parts...)...)
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return ""
	}
	return path
}

func presetsRoot() string {
	if declaredAssets("presets", "manifest.json") != "" {
		return declaredAssetDir("presets")
	}
	return extractAssets("presets", embedded.Presets())
}

func runtimeScript(name string) string {
	if path := declaredAssets("src", "runtime", name); path != "" {
		return path
	}
	return extractAsset("runtime", name, embedded.Runtime())
}

func warmRuntimeAssets() {
	if declaredAssetDir("src", "runtime") != "" {
		return
	}
	extractAssets("runtime", embedded.Runtime())
}

func elkScript() string {
	return declaredAssets("node_modules", "elkjs", "lib", "elk.bundled.js")
}

func extractAssets(name string, source fs.FS) string {
	root := filepath.Join(assetCacheDir(), name)
	walk := func(relative string, entry fs.DirEntry, incoming error) error {
		if incoming != nil {
			return incoming
		}
		target := filepath.Join(root, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		body, err := fs.ReadFile(source, relative)
		if err != nil {
			return err
		}
		return writeAsset(target, body)
	}
	if err := fs.WalkDir(source, ".", walk); err != nil {
		panic(err)
	}
	return root
}

func extractAsset(group, name string, source fs.FS) string {
	body, err := fs.ReadFile(source, name)
	if err != nil {
		panic(err)
	}
	target := filepath.Join(assetCacheDir(), group, name)
	if err := writeAsset(target, body); err != nil {
		panic(err)
	}
	return target
}

func writeAsset(target string, body []byte) error {
	if existing, err := os.ReadFile(target); err == nil && bytes.Equal(existing, body) {
		return nil
	}
	directory := filepath.Dir(target)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".asset-")
	if err != nil {
		return err
	}
	staging := temporary.Name()
	discard := func() {
		_ = os.Remove(staging)
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		discard()
		return err
	}
	if err := temporary.Close(); err != nil {
		discard()
		return err
	}
	if err := os.Chmod(staging, 0o444); err != nil {
		discard()
		return err
	}
	if err := os.Rename(staging, target); err != nil {
		discard()
		return err
	}
	return nil
}
