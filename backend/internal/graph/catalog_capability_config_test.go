package graph

import (
	"os"
	"path/filepath"
	"testing"
)

func writeCapabilityDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if err := writeCapabilityFiles(dir, files); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeCapabilityFiles(dir string, files map[string]string) error {
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func TestAPlainSkillNeedsNoCapabilityJSON(t *testing.T) {
	dir := writeCapabilityDir(t, map[string]string{"SKILL.md": "# pstack\n"})
	record := CapabilityRecord{Id: "pstack", Kind: "skill", Version: "local", Source: dir, Snapshot: map[string]any{"path": dir}}
	view := CapabilityConfigViewOf(record, nil)
	if view.Error != "" {
		t.Fatalf("a skill without capability.json is not broken, got error %q", view.Error)
	}
	if !view.Ready {
		t.Fatalf("a skill without env fields is ready, got %+v", view)
	}
	views := CapabilityConfigViews([]CapabilityRecord{record}, nil)
	if len(views) != 0 {
		t.Fatalf("a plain skill is not a config view, got %+v", views)
	}
}

func TestAnMCPWithoutCapabilityJSONKeepsItsError(t *testing.T) {
	dir := writeCapabilityDir(t, map[string]string{"package.json": "{}"})
	record := CapabilityRecord{Id: "broken-mcp", Kind: "mcp", Version: "1.0.0", Source: dir, Snapshot: map[string]any{"path": dir}}
	views := CapabilityConfigViews([]CapabilityRecord{record}, nil)
	if len(views) != 1 {
		t.Fatalf("a broken mcp stays visible as a config problem, got %+v", views)
	}
	if views[0].Error == "" || views[0].Ready {
		t.Fatalf("the broken mcp keeps its error and is not ready, got %+v", views[0])
	}
}

func TestASkillWithEnvFieldsStillListsThem(t *testing.T) {
	dir := writeCapabilityDir(t, map[string]string{
		"SKILL.md":        "# search\n",
		"capability.json": `{"id":"search","name":"Search","kind":"skill","version":"1.0.0","headersEnv":{"x-api-key":"SKILL_API_KEY"}}`,
	})
	record := CapabilityRecord{Id: "search", Kind: "skill", Version: "1.0.0", Source: dir, Snapshot: map[string]any{"path": dir}}
	views := CapabilityConfigViews([]CapabilityRecord{record}, nil)
	if len(views) != 1 || len(views[0].Fields) != 1 || views[0].Fields[0].Env != "SKILL_API_KEY" {
		t.Fatalf("a skill declaring env fields still shows them, got %+v", views)
	}
	if views[0].Ready {
		t.Fatalf("a missing env keeps it out of ready, got %+v", views[0])
	}
}
