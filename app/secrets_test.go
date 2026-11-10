package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecretsRoundTripKeepsTheElectronFileFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	value := "sk-live-123"
	if err := saveSecret(path, "GRAPH_KEY", &value); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file seedsShape
	if err := json.Unmarshal(payload, &file); err != nil {
		t.Fatal(err)
	}
	if file.Version != 1 || len(file.Entries) != 1 {
		t.Fatalf("file %+v", file)
	}
	sealed, err := base64.StdEncoding.DecodeString(file.Entries["GRAPH_KEY"])
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) < 12+16+len(value) {
		t.Fatalf("sealed payload of %d bytes cannot carry %q", len(sealed), value)
	}
	if !strings.HasSuffix(string(payload), "\n") {
		t.Fatal("the file must end with a newline")
	}
	if values := secretValues(path); values["GRAPH_KEY"] != value {
		t.Fatalf("round trip gave %q", values["GRAPH_KEY"])
	}
}

type seedsShape struct {
	Version int               `json:"version"`
	Entries map[string]string `json:"entries"`
}

func TestSecretsKeyFileIsPrivateAndStable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	value := "sk-live"
	if err := saveSecret(path, "GRAPH_KEY", &value); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(secretsKeyPath(path))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", info.Mode().Perm())
	}
	sealed := readEntries(t, path)["GRAPH_KEY"]
	if err := saveSecret(path, "GRAPH_OTHER", &value); err != nil {
		t.Fatal(err)
	}
	if readEntries(t, path)["GRAPH_KEY"] != sealed {
		t.Fatal("a second save re-keyed the file: earlier secrets would stop opening")
	}
}

func TestSecretStatusNeedsTheKeyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	value := "sk-live"
	if err := saveSecret(path, "GRAPH_KEY", &value); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(secretsKeyPath(path)); err != nil {
		t.Fatal(err)
	}
	if secretStatus(path, []string{"GRAPH_KEY"})["GRAPH_KEY"] {
		t.Fatal("without the key file a sealed value must read as unconfigured")
	}
	if values := secretValues(path); len(values) != 0 {
		t.Fatalf("values %v", values)
	}
}

func readEntries(t *testing.T, path string) map[string]string {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file seedsShape
	if err := json.Unmarshal(payload, &file); err != nil {
		t.Fatal(err)
	}
	return file.Entries
}
