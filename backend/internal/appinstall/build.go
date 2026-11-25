package appinstall

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func BuildBackend(root string, onlyIfStale bool) (string, error) {
	output := filepath.Join(root, "dist", "graphd")
	if onlyIfStale {
		if _, err := os.Stat(output); err == nil && !backendStale(root, output) {
			return output, nil
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "dist"), 0o755); err != nil {
		return "", err
	}
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-o", output, "./cmd/graphd")
	build.Dir = filepath.Join(root, "backend")
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return "", fmt.Errorf("go build failed: %v", err)
	}
	return output, nil
}

func backendStale(root, output string) bool {
	built, err := os.Stat(output)
	if err != nil {
		return true
	}
	for _, candidate := range []string{
		filepath.Join(root, "backend", "go.mod"),
		filepath.Join(root, "backend", "go.sum"),
	} {
		if info, statErr := os.Stat(candidate); statErr == nil && info.ModTime().After(built.ModTime()) {
			return true
		}
	}
	return newestGoSource(filepath.Join(root, "backend")) > built.ModTime().UnixNano()
}

func newestGoSource(directory string) int64 {
	var newest int64
	_ = filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if info.ModTime().UnixNano() > newest {
			newest = info.ModTime().UnixNano()
		}
		return nil
	})
	return newest
}

func PackageApp(root string, printer func(string)) error {
	build := exec.Command("go", "tool", "mygo", "build")
	build.Dir = filepath.Join(root, "app")
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("go tool mygo build failed: %v", err)
	}
	built := filepath.Join(root, "app", "build", "darwin-arm64", "Graph.app")
	target := filepath.Join(root, "dist", "app", "mac-arm64")
	bundle := filepath.Join(target, "Graph.app")
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	if err := copyTree(built, bundle); err != nil {
		return err
	}
	binary := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	info, err := os.Stat(binary)
	if err != nil {
		return err
	}
	total, err := directorySize(bundle)
	if err != nil {
		return err
	}
	if printer != nil {
		printer(fmt.Sprintf("[app-mygo] %s", bundle))
		printer(fmt.Sprintf("[app-mygo] shell binary %.1f MiB, bundle %.1f MiB", float64(info.Size())/(1024*1024), float64(total)/(1024*1024)))
	}
	return nil
}

func directorySize(directory string) (int64, error) {
	var total int64
	err := filepath.Walk(directory, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || info.IsDir() {
			return nil
		}
		total += info.Size()
		return nil
	})
	return total, err
}

func RepoRoot() (string, error) {
	current, err := os.Getwd()
	if err != nil {
		return "", err
	}
	directory := current
	for {
		if _, statErr := os.Stat(filepath.Join(directory, ".git")); statErr == nil {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return current, nil
		}
		directory = parent
	}
}
