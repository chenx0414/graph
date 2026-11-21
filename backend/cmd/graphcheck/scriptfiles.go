package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// This repository is Go, so a script file can only run as the sandbox host for a `node` check.
var allowedScriptFiles = []string{
	"src/runtime/module-worker.mjs",
	"src/runtime/check-resolver.cjs",
	"backend/internal/graph/embedded/runtime/module-worker.mjs",
	"backend/internal/graph/embedded/runtime/check-resolver.cjs",
}

var scriptFileExtensions = []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}

var scriptFileSkippedDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true,
}

func isScriptFile(path string) bool {
	lower := strings.ToLower(path)
	for _, extension := range scriptFileExtensions {
		if strings.HasSuffix(lower, extension) {
			return true
		}
	}
	return false
}

func scanScriptFiles(root string, allowed []string) ([]string, error) {
	permitted := map[string]bool{}
	for _, entry := range allowed {
		permitted[filepath.ToSlash(entry)] = true
	}
	offenders := []string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, incoming error) error {
		if incoming != nil {
			return incoming
		}
		name := entry.Name()
		if entry.IsDir() {
			if scriptFileSkippedDirs[name] {
				return filepath.SkipDir
			}
			return nil
		}
		if !isScriptFile(name) {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		if permitted[relative] {
			return nil
		}
		offenders = append(offenders, relative)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(offenders)
	return offenders, nil
}

func runScriptFiles(root string) int {
	offenders, err := scanScriptFiles(root, allowedScriptFiles)
	if err != nil {
		fmt.Fprintf(os.Stderr, "script files: %v\n", err)
		return 2
	}
	if len(offenders) == 0 {
		fmt.Printf("script files: only the %d allowed sandbox host file(s)\n", len(allowedScriptFiles))
		return 0
	}
	fmt.Fprintf(os.Stderr, "script files: this repository is Go; %d file(s) nothing can run:\n", len(offenders))
	for _, path := range offenders {
		fmt.Fprintf(os.Stderr, "  %s\n", path)
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Allowed, because node loads them as the sandbox host for a `node` check:")
	for _, path := range allowedScriptFiles {
		fmt.Fprintf(os.Stderr, "  %s\n", path)
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Delete the file, or rewrite the behaviour in Go.")
	return 1
}
