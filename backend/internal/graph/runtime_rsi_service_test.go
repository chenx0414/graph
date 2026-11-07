package graph

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRsiIsAvailableThroughASymlinkedCheckout(t *testing.T) {
	real := filepath.Join(t.TempDir(), "checkout")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if result := Git(real, []string{"init", "-q", "-b", "main"}, nil, nil); result.Code != 0 {
		t.Fatalf("git init: %s", result.Stderr)
	}
	if err := os.WriteFile(filepath.Join(real, "package.json"), []byte("{\"name\":\"x\"}\n"), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	root := link
	service := NewRsiService(RsiServiceOptions{Root: &root, StateDir: t.TempDir()})
	if !service.Available {
		t.Fatalf("a checkout reached through a symlink reports no self-improvement surface: root=%v repo=%v",
			service.Root, DetectRepo(link))
	}
}

func TestRsiResolvesTheConfiguredRootThroughTheEnvironment(t *testing.T) {
	real := filepath.Join(t.TempDir(), "checkout")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if result := Git(real, []string{"init", "-q", "-b", "main"}, nil, nil); result.Code != 0 {
		t.Fatalf("git init: %s", result.Stderr)
	}
	if err := os.WriteFile(filepath.Join(real, "package.json"), []byte("{\"name\":\"x\"}\n"), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	root := ResolveRsiRoot(map[string]string{"GRAPH_RSI_ROOT": real}, t.TempDir())
	if root == nil {
		t.Fatalf("GRAPH_RSI_ROOT was ignored")
	}
	service := OpenRsiService(RsiServiceOptions{Root: root, StateDir: t.TempDir()})
	if !service.Available {
		t.Fatalf("a configured checkout with package.json reports no self-improvement surface: root=%v repo=%v", *root, DetectRepo(*root))
	}
}
