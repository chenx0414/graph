package graph

import (
	"os"
	"path/filepath"
	"testing"
)

func useEmptyApplicationRoot(t *testing.T) {
	t.Helper()
	previousRoot := ApplicationRoot
	previousCache := assetCacheDirOverride
	ApplicationRoot = t.TempDir()
	assetCacheDirOverride = filepath.Join(t.TempDir(), "asset-cache")
	t.Cleanup(func() {
		ApplicationRoot = previousRoot
		assetCacheDirOverride = previousCache
	})
}

func TestBootstrapPresetsSurviveAnEmptyApplicationRoot(t *testing.T) {
	useEmptyApplicationRoot(t)

	bootstrap := LoadPresetBootstrap(presetsRoot(), nil)
	if !bootstrap.Available {
		t.Fatalf("the embedded preset pack was not used when the application root had no presets: %q", presetsRoot())
	}
	if len(bootstrap.Definitions) != 4 {
		t.Fatalf("expected the four bootstrap definitions from the embedded pack, got %d (%v)", len(bootstrap.Definitions), bootstrap.Installed)
	}
	if bootstrap.Prompts["main"] == "" {
		t.Fatal("the embedded master prompt was not readable through the resolved presets root")
	}
	if len(bootstrap.Failed) != 0 {
		t.Fatalf("the embedded preset pack should load without failures, got %v", bootstrap.Failed)
	}
}

func TestDiskPresetsWinOverTheEmbeddedCopy(t *testing.T) {
	useEmptyApplicationRoot(t)

	disk := filepath.Join(ApplicationRoot, "presets")
	if err := os.MkdirAll(filepath.Join(disk, "bootstrap", "master"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"version":2,"bootstrap":{"prompts":{"main":"bootstrap/master/agent.md"},"definitions":[{"id":"only-disk"}]}}`
	if err := os.WriteFile(filepath.Join(disk, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(disk, "bootstrap", "master", "agent.md"), []byte("disk prompt"), 0o644); err != nil {
		t.Fatal(err)
	}

	bootstrap := LoadPresetBootstrap(presetsRoot(), nil)
	if !bootstrap.Available {
		t.Fatal("a complete preset pack on disk was not used")
	}
	if len(bootstrap.Definitions) != 1 || bootstrap.Definitions[0].Id != "only-disk" {
		t.Fatalf("the embedded pack shadowed the pack on disk: %v", bootstrap.Definitions)
	}
	if bootstrap.Prompts["main"] != "disk prompt" {
		t.Fatalf("expected the prompt from disk, got %q", bootstrap.Prompts["main"])
	}
}

func TestRuntimeScriptsSurviveAnEmptyApplicationRoot(t *testing.T) {
	useEmptyApplicationRoot(t)

	for _, name := range []string{"module-worker.mjs", "check-resolver.cjs"} {
		path := runtimeScript(name)
		if path == "" {
			t.Fatalf("%s was not resolved when the application root had no src/runtime", name)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s was resolved to an unreadable path %q: %v", name, path, err)
		}
		if len(content) == 0 {
			t.Fatalf("%s was resolved to an empty file at %q", name, path)
		}
		if info, err := os.Stat(path); err != nil || info.Mode().Perm()&0o400 == 0 {
			t.Fatalf("%s was resolved to a path the daemon cannot read back: %q", name, path)
		}
	}
}

func TestRuntimeScriptsOnDiskWinOverTheEmbeddedCopy(t *testing.T) {
	useEmptyApplicationRoot(t)

	disk := filepath.Join(ApplicationRoot, "src", "runtime")
	if err := os.MkdirAll(disk, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(disk, "module-worker.mjs"), []byte("disk worker"), 0o644); err != nil {
		t.Fatal(err)
	}

	path := runtimeScript("module-worker.mjs")
	if path != filepath.Join(disk, "module-worker.mjs") {
		t.Fatalf("the copy on disk was not preferred, resolved to %q", path)
	}
}

func TestExtractedAssetsStayStableAcrossResolutions(t *testing.T) {
	useEmptyApplicationRoot(t)

	first := runtimeScript("check-resolver.cjs")
	if first == "" {
		t.Fatal("check-resolver.cjs was not resolved")
	}
	if err := os.Chmod(first, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(first, []byte("corrupted"), 0o644); err != nil {
		t.Fatal(err)
	}
	second := runtimeScript("check-resolver.cjs")
	if second != first {
		t.Fatalf("the extracted cache path moved between resolutions: %q then %q", first, second)
	}
	content, err := os.ReadFile(second)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) == "corrupted" {
		t.Fatal("a corrupted extraction was left in place instead of being rewritten from the embedded copy")
	}
}

func TestTheElkLayoutStaysOptional(t *testing.T) {
	useEmptyApplicationRoot(t)

	if path := elkScript(); path != "" {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("elkScript handed out a path that does not exist: %q", path)
		}
	}
	graph := map[string]any{"id": "root", "children": []any{
		map[string]any{"id": "a", "width": 160.0, "height": 64.0},
		map[string]any{"id": "b", "width": 160.0, "height": 64.0},
	}}
	laid := layoutElk(graph)
	children, _ := laid["children"].([]any)
	if len(children) != 2 {
		t.Fatalf("the fallback layout dropped its children: %v", laid)
	}
	for _, raw := range children {
		child, _ := raw.(map[string]any)
		if child["y"].(float64) == 0 && child["id"] != "a" {
			continue
		}
		if _, ok := child["x"]; !ok {
			t.Fatalf("the fallback layout left %v unpositioned", child["id"])
		}
	}
}
