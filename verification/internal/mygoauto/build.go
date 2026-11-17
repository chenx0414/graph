package mygoauto

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const pluginSource = `//go:build e2e

package main

import _ "github.com/egoist/mygo/plugins/automation"
`

type BuildRecord struct {
	Binary        string    `json:"binary"`
	SHA256        string    `json:"sha256"`
	SizeBytes     int64     `json:"sizeBytes"`
	Tags          []string  `json:"tags"`
	OverlayFiles  []string  `json:"overlayFiles"`
	Replacements  int       `json:"replacements"`
	MygoName      string    `json:"mygoName"`
	MygoID        string    `json:"mygoIdentifier"`
	SourceCommit  string    `json:"sourceCommit"`
	SourceDirty   bool      `json:"sourceDirty"`
	BuiltAt       time.Time `json:"builtAt"`
	InjectedFile  string    `json:"injectedFile"`
	injectedClone string
}

func appDir(repoRoot string) string { return filepath.Join(repoRoot, "app") }

// Overlay adds exactly one file to the app package. A mapping that would
// replace an existing app/ file is refused: the build must stay the real
// product plus the automation plugin, nothing else.
func overlayFiles(repoRoot, runDir string) (map[string]string, error) {
	target := filepath.Join(appDir(repoRoot), "zz_automation_e2e.go")
	if _, err := os.Stat(target); err == nil {
		return nil, errors.New("mygoauto: app/zz_automation_e2e.go exists in the checkout; refusing to build (the overlay must only add files)")
	}
	injected := filepath.Join(runDir, "build", "automation_e2e.go")
	if err := os.MkdirAll(filepath.Dir(injected), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(injected, []byte(pluginSource), 0o644); err != nil {
		return nil, err
	}
	return map[string]string{target: injected}, nil
}

func writeOverlay(runDir string, replacements map[string]string) (string, error) {
	document := struct {
		Replace map[string]string `json:"Replace"`
	}{Replace: replacements}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(runDir, "build", "overlay.json")
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// Build compiles the app with the automation plugin linked, renamed so its
// single-instance lock and app-support directory stay apart from the user's
// Graph.
func Build(ctx context.Context, opts Options) (BuildRecord, error) {
	record := BuildRecord{Tags: []string{"e2e"}, BuiltAt: time.Now()}
	if opts.RepoRoot == "" {
		return record, errors.New("mygoauto: RepoRoot is required")
	}
	if opts.RunDir == "" {
		return record, errors.New("mygoauto: RunDir is required")
	}
	name, identifier := opts.appIdentity()
	record.MygoName, record.MygoID = name, identifier
	replacements, err := overlayFiles(opts.RepoRoot, opts.RunDir)
	if err != nil {
		return record, err
	}
	for target := range replacements {
		record.OverlayFiles = append(record.OverlayFiles, target)
	}
	record.Replacements = len(replacements)
	overlay, err := writeOverlay(opts.RunDir, replacements)
	if err != nil {
		return record, err
	}
	binary := filepath.Join(opts.RunDir, "bin", "graph-verify-ui")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		return record, err
	}
	ldflags := fmt.Sprintf("-X github.com/egoist/mygo.packageName=%s -X github.com/egoist/mygo.packageIdentifier=%s", name, identifier)
	command := exec.CommandContext(ctx, "go", "build", "-tags", "e2e", "-overlay", overlay, "-ldflags", ldflags, "-o", binary, ".")
	command.Dir = appDir(opts.RepoRoot)
	command.Env = os.Environ()
	if output, err := command.CombinedOutput(); err != nil {
		return record, fmt.Errorf("mygoauto: go build failed: %w\n%s", err, strings.TrimSpace(string(output)))
	}
	info, err := os.Stat(binary)
	if err != nil {
		return record, err
	}
	digest, err := fileSHA(binary)
	if err != nil {
		return record, err
	}
	record.Binary, record.SHA256, record.SizeBytes = binary, digest, info.Size()
	record.SourceCommit, record.SourceDirty = gitState(opts.RepoRoot)
	return record, nil
}

func fileSHAOf(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func fileSHA(path string) (string, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func gitState(repoRoot string) (string, bool) {
	commit := ""
	if output, err := exec.Command("git", "-C", repoRoot, "rev-parse", "HEAD").Output(); err == nil {
		commit = strings.TrimSpace(string(output))
	}
	dirty := false
	if output, err := exec.Command("git", "-C", repoRoot, "status", "--porcelain").Output(); err == nil {
		dirty = strings.TrimSpace(string(output)) != ""
	}
	return commit, dirty
}
