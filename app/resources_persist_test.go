package main

import (
	"path/filepath"
	"testing"
)

func TestTheSecretsFileHoldsOnlyWhatThePageKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	value := "sk-round-trip"
	if err := saveSecret(path, "ROUND_TRIP_KEY", &value); err != nil {
		t.Fatalf("save: %v", err)
	}
	if values := secretValues(path); values["ROUND_TRIP_KEY"] != value {
		t.Fatalf("the value survives a reload, got %v", values)
	}
	if err := saveSecret(path, "ROUND_TRIP_KEY", nil); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if values := secretValues(path); len(values) != 0 {
		t.Fatalf("a revoked value leaves nothing behind, got %v", values)
	}
}
