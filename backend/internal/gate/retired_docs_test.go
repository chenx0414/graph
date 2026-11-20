package gate

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemovedReferenceDocsStayGone(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	replaced := map[string]string{
		"docs/agent/state-machines.md":                         "go -C backend run ./cmd/graphcheck machines --verbose, or GET /api/state-machines",
		"docs/agent/state-machines-reference.md":               "switched into the registry: go -C backend run ./cmd/graphcheck machines --verbose",
		"docs/specs/implicit-state-machines.md":                "the machines.json registry plus the machines gate",
		"docs/agent/models-and-providers.md":                   "read_system_capabilities section=configuredModels, and the console providers page",
		"docs/agent/capabilities.md":                           "read_system_capabilities section=capabilities, and GET /api/catalog",
		"docs/agent/self-configuration.md":                     "GET /api/agent-context (prompts, defaults, tool selection) and inspect_rsi_status",
		"docs/agent/troubleshooting.md":                        "inspect_graph_system, list_problems and get_task_status",
		"docs/agent/execution-model.md":                        "get_task_status, graph_inspect and the queue view",
		"docs/agent/graph-overview.md":                         "AGENTS.md and FEATURE_MAP.md",
		"docs/agent/permissions-and-recovery.md":               "inspect_graph_system and list_problems",
		"docs/agent/artifacts-and-git.md":                      "artifact_read, git and graph_inspect query=acceptance",
		"docs/agent/model-fallback.md":                         "read_system_capabilities section=configuredModels",
		"docs/agent/provider-authorization.md":                 "read_system_capabilities section=subscriptionPlans and the console providers page",
		"docs/agent/INDEX.md":                                  "AGENTS.md is the index; it names the two documents and the tools",
		"docs/agent/README.md":                                 "AGENTS.md and FEATURE_MAP.md",
		"docs/guides/ci.md":                                    "FEATURE_MAP.md CI layers section, generated from the workflows",
		"docs/guides/eval.md":                                  "go -C backend run ./cmd/graphcheck eval --help and go -C backend run ./cmd/grapheval --help",
		"docs/specs/dynamic-agent-spawn.md":                    "the spawn tools themselves and their schema",
		"docs/specs/fleet-collaboration-1000.md":               "the fleet page and its scale tests",
		"docs/specs/multi-agent-write-isolation-2026-09-28.md": "the worktree isolation code and the ownership gate",
		"docs/specs/pi-durable-kernel.md":                      "the pigkernel package and its tests",
	}
	for relative, replacement := range replaced {
		if _, statErr := os.Stat(filepath.Join(root, relative)); statErr == nil {
			t.Errorf("%s is back; that fact is answered by %s and a second copy will drift", relative, replacement)
		}
	}
}

func TestOnlyTwoDocumentsAreEntryPoints(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	allowed := map[string]bool{"AGENTS.md": true, GateFeatureMapPath: true}
	skipped := map[string]bool{"node_modules": true, "dist": true, ".git": true, ".emergence": true, "coordination": true, "state": true}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if skipped[entry.Name()] || entry.Name() == ".agents" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".md") {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		if allowed[relative] {
			return nil
		}
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(payload), ProseExemptDirective) {
			return nil
		}
		if strings.Contains(string(payload), "read this first") || strings.Contains(string(payload), "先读") {
			t.Errorf("%s tells an agent to read it first; only AGENTS.md and %s may be entry points", relative, GateFeatureMapPath)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk repository: %v", err)
	}
}
