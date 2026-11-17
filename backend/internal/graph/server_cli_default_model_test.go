package graph

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

const defaultModelConfig = `{
  "version": 1,
  "revision": 3,
  "configured": true,
  "credentials": {
    "cred": {"secretRef": "GRAPH_TEST_KEY"}
  },
  "models": {
    "entries": [
      {"id": "first", "provider": "p", "api": "openai-completions", "baseUrl": "http://127.0.0.1:1", "contextWindow": 1000, "maxTokens": 100, "credentialId": "cred"},
      {"id": "second", "provider": "p", "api": "openai-completions", "baseUrl": "http://127.0.0.1:1", "contextWindow": 1000, "maxTokens": 100, "credentialId": "cred"}
    ]
  }
}
`

func defaultModelFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "graph.config.json")
	if err := os.WriteFile(path, []byte(defaultModelConfig), 0o600); err != nil {
		t.Fatalf("write the config: %v", err)
	}
	return path
}

func readDefaultModel(t *testing.T, path string) (string, int) {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the config: %v", err)
	}
	document, err := parseOrderedJSON(string(text))
	if err != nil {
		t.Fatalf("parse the config: %v", err)
	}
	model := ""
	if raw, ok := document.get("masterModel"); ok {
		model = raw.str
	}
	revision := 0
	if raw, ok := document.get("revision"); ok {
		if value, err := strconv.Atoi(raw.num); err == nil {
			revision = value
		}
	}
	return model, revision
}

func TestTheCLISetsTheDefaultModel(t *testing.T) {
	path := defaultModelFile(t)
	env := map[string]string{"GRAPH_TEST_KEY": "key"}
	if code := runDefaultModel([]string{"--config", path, "second"}, t.TempDir(), env); code != 0 {
		t.Fatalf("setting a configured model has to succeed, exit %d", code)
	}
	if model, revision := readDefaultModel(t, path); model != "second" {
		t.Fatalf("the file has to carry the default model, got %q", model)
	} else if revision != 4 {
		t.Fatalf("the save has to bump the revision, got %d", revision)
	}
}

func TestTheCLIRefusesAModelThatIsNotConfigured(t *testing.T) {
	path := defaultModelFile(t)
	env := map[string]string{"GRAPH_TEST_KEY": "key"}
	if code := runDefaultModel([]string{"--config", path, "no-such-model"}, t.TempDir(), env); code == 0 {
		t.Fatal("a model that is not configured cannot become the default")
	}
	if model, revision := readDefaultModel(t, path); model != "" || revision != 3 {
		t.Fatalf("a refused write must leave the file alone, model %q revision %d", model, revision)
	}
}
