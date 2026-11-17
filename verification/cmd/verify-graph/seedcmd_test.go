package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func seedTestMeta(t *testing.T) runMeta {
	t.Helper()
	root := t.TempDir()
	meta := runMeta{
		RunID:     "seedtest",
		StateDir:  filepath.Join(root, "state"),
		GraphHome: filepath.Join(root, "graph-home"),
		Config:    filepath.Join(root, "graph.config.json"),
		Home:      filepath.Join(root, "home"),
		Logs:      filepath.Join(root, "logs"),
	}
	for _, dir := range []string{meta.StateDir, meta.GraphHome, meta.Home, meta.Logs} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return meta
}

func TestASeedRecordRoundTripsThroughTheRunDirectory(t *testing.T) {
	meta := seedTestMeta(t)
	if _, ok := readSeedRecord(meta); ok {
		t.Fatal("a run without a stub model must not report one")
	}
	record := seedRecord{PID: os.Getpid(), Start: lstart(os.Getpid()), BaseURL: "http://127.0.0.1:1234/v1", Model: "seed"}
	payload, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(seedRecordPath(meta), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	read, ok := readSeedRecord(meta)
	if !ok {
		t.Fatal("a written record must be readable")
	}
	if read.BaseURL != record.BaseURL || read.PID != record.PID || read.Model != "seed" {
		t.Fatalf("record %+v", read)
	}
}

func TestASeedRecordWithoutAnAddressIsIgnored(t *testing.T) {
	meta := seedTestMeta(t)
	if err := os.WriteFile(seedRecordPath(meta), []byte(`{"pid":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := readSeedRecord(meta); ok {
		t.Fatal("a record without baseUrl would make the daemon call nothing")
	}
}

func TestTheSeededConfigPointsTheModelAtTheStubAndKeepsItsProject(t *testing.T) {
	meta := seedTestMeta(t)
	record := seedRecord{BaseURL: "http://127.0.0.1:4321/v1", Model: "seed"}
	if err := writeSeedConfig(meta, record); err != nil {
		t.Fatalf("write seeded config: %v", err)
	}
	payload, err := os.ReadFile(meta.Config)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, want := range []string{record.BaseURL, `"openai-completions"`, `"seed"`, `"secretRef"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("the seeded config must contain %q, got %s", want, text)
		}
	}
	if strings.Contains(text, "sk-") {
		t.Fatalf("the config must reference a credential, never carry a key: %s", text)
	}
	var document struct {
		Projects []struct {
			ID   string `json:"id"`
			Root string `json:"root"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Projects) != 1 || document.Projects[0].ID != "verify" {
		t.Fatalf("the seeded config must keep the fixture project, got %+v", document.Projects)
	}
	if !strings.HasSuffix(document.Projects[0].Root, "project") {
		t.Fatalf("the project must point inside the run directory, got %q", document.Projects[0].Root)
	}
}

func TestStoppingASeedThatIsNotOursIsRefused(t *testing.T) {
	meta := seedTestMeta(t)
	payload, err := json.Marshal(seedRecord{PID: os.Getpid(), Start: "not-the-real-start", BaseURL: "http://127.0.0.1:1/v1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(seedRecordPath(meta), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	problem := stopSeed(meta)
	if problem == "" || !strings.Contains(problem, "not the stub model") {
		t.Fatalf("a reused pid must be refused, got %q", problem)
	}
	if !alive(os.Getpid()) {
		t.Fatal("the refusal must not have killed anything")
	}
}
