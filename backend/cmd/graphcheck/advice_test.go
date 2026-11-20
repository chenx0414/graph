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

func captureStdout(t *testing.T, run func()) string {
	t.Helper()
	original := os.Stdout
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = write
	defer func() { os.Stdout = original }()
	run()
	os.Stdout = original
	write.Close()
	payload, readErr := io.ReadAll(read)
	read.Close()
	if readErr != nil {
		t.Fatalf("read stdout: %v", readErr)
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

func TestTokenBudgetFailureNamesTheLimitOverride(t *testing.T) {
	findings := gate.TokenFindings{Violations: []gate.FileRecord{{Path: "backend/big.go", Bytes: 40000}}}
	output := captureStderr(t, func() { reportTokens(findings, 5000) })
	for _, want := range []string{
		"backend/big.go",
		"Split these files before committing",
		"graph:allow-large-file: <reason>",
		"GRAPH_FILE_TOKEN_LIMIT",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}

func TestTableOwnershipFailureNamesTheEscapes(t *testing.T) {
	root := t.TempDir()
	offender := filepath.Join(root, "backend", "graph", "stray.go")
	if err := os.MkdirAll(filepath.Dir(offender), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(offender, []byte("package graph\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	offenders := []gate.TableOffender{{File: offender, Table: "task_nodes"}}
	status := 0
	output := captureStderr(t, func() {
		status = reportTableOwnership(root, offenders, false, nil)
	})
	if status == 0 {
		t.Fatalf("an outside writer must fail, got status %d", status)
	}
	for _, want := range []string{
		"task_nodes",
		"stray.go",
		"owner",
		"graph:table-writes-exempt:",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
	clean := ""
	clean = captureStdout(t, func() { reportTableOwnership(root, nil, false, nil) })
	if !strings.Contains(clean, "writes no owned table outside its owner") {
		t.Fatalf("a clean package must report success, got:\n%s", clean)
	}
}

func TestAPIContractFailureExplainsTheRequestID(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "app"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := "package main\nfunc f(api apiClient) {\n\tapi.post(\"/api/projects/p1/archive\", nil)\n}\n"
	if err := os.WriteFile(filepath.Join(root, "app", "bad.go"), []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	status := 0
	output := captureStderr(t, func() { status = runAPI(root) })
	if status == 0 {
		t.Fatalf("an archive POST without a request id must fail, got status %d", status)
	}
	for _, want := range []string{"/api/projects/p1/archive", "requestId", "replay"} {
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
		"machines --verbose",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}

func TestEvidenceFailureNamesTheOverride(t *testing.T) {
	status := 0
	output := captureStderr(t, func() {
		status = reportEvidenceProblems([]string{"acceptance-evidence/layout.md"})
	})
	if status == 0 {
		t.Fatalf("changed evidence must fail the check, got status %d", status)
	}
	for _, want := range []string{"acceptance-evidence/layout.md", "GRAPH_UPDATE_EVIDENCE=1"} {
		if !strings.Contains(output, want) {
			t.Errorf("failure output does not mention %q:\n%s", want, output)
		}
	}
}
