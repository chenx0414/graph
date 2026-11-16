package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeAPITestFile(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAPIPostLintRejectsArchiveWithoutRequestID(t *testing.T) {
	dir := writeAPITestFile(t, "bad.go", `package main
func f(api apiClient) {
	api.post("/api/projects/p1/archive", nil)
}
`)
	problems, err := scanAPIPosts(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 1 {
		t.Fatalf("a project archive POST without a request id is rejected, got %v", problems)
	}
}

func TestAPIPostLintAcceptsRequestID(t *testing.T) {
	dir := writeAPITestFile(t, "good.go", `package main
func f(api apiClient) {
	body := map[string]any{"requestId": requestID("archive")}
	api.post("/api/projects/p1/archive", body)
	api.post("/api/projects/p1/restore", map[string]any{"requestId": requestID("restore")})
}
`)
	problems, err := scanAPIPosts(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 0 {
		t.Fatalf("archive and restore calls with a request id pass, got %v", problems)
	}
}

func TestAPIPostLintIgnoresOtherPosts(t *testing.T) {
	dir := writeAPITestFile(t, "other.go", `package main
func f(s shellState, api apiClient) {
	s.post("/api/projects/p1/archive")
	api.post("/api/catalog/refresh", nil)
}
`)
	problems, err := scanAPIPosts(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 0 {
		t.Fatalf("only direct API project lifecycle posts are checked, got %v", problems)
	}
}
