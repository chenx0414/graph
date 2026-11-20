package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chenx0414/graph/backend/internal/gate"
)

func captureStderr(t *testing.T, run func()) string {
	t.Helper()
	original := os.Stderr
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stderr = write
	defer func() { os.Stderr = original }()
	run()
	os.Stderr = original
	write.Close()
	payload, readErr := io.ReadAll(read)
	read.Close()
	if readErr != nil {
		t.Fatalf("read stderr: %v", readErr)
	}
	return string(payload)
}

func TestCommentBudgetFailureExplainsTheFix(t *testing.T) {
	root := t.TempDir()
	body := "package main\n"
	for index := 0; index < gate.ExplainBudgetPerFile+1; index++ {
		body += "// this comment explains what the next line does\n"
	}
	body += "func f() {}\n"
	if err := os.MkdirAll(filepath.Join(root, "backend"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "backend", "lesson.go"), []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	status := 0
	output := captureStderr(t, func() { status = runComments(root, nil) })
	if status == 0 {
		t.Fatalf("an over-budget file must fail, got status %d", status)
	}
	for _, want := range []string{
		"lesson.go",
		"machine directive",
		"// graph:",
		"go -C backend run ./cmd/graphcheck comments",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}

func TestMachineFailureNamesTheRegistryAndTheRegeneration(t *testing.T) {
	problems := []gate.RegistryProblem{{Kind: "undeclared-state", Detail: "task.phase = waiting (backend/x.go)"}}
	status := 0
	output := captureStderr(t, func() {
		status = reportMachineProblems(problems)
	})
	if status == 0 {
		t.Fatalf("declared problems must fail the check, got status %d", status)
	}
	for _, want := range []string{
		"undeclared-state",
		"backend/statemachine/machines.json",
		"GRAPH_UPDATE_ATLAS=1 go -C backend test ./statemachine -run Atlas",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}
