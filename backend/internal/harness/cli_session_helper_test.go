package harness

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// repositoryForTest is the checkout the CLI runs against.
func repositoryForTest(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve the repository root: %v", err)
	}
	return root
}

// decodePNGFile reads a picture the CLI wrote, so an assertion is about the pixels rather than
// about the file merely existing.
func decodePNGFile(path string) (image.Image, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	decoded, err := png.Decode(file)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

// runCLIForTest runs the CLI the way an Agent does: as a subprocess, arguments in, exit code out.
func runCLIForTest(t *testing.T, args ...string) (int, string) {
	t.Helper()
	command := exec.Command("go", append([]string{
		"-C", filepath.Join(repositoryForTest(t), "backend"), "run", "./cmd/graphcli",
	}, args...)...)
	var output bytes.Buffer
	command.Env = append(os.Environ(), "GRAPH_REPOSITORY="+repositoryForTest(t))
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatalf("run the CLI: %v", err)
	}
	return code, output.String()
}

// jsonStringField reads one string field out of a CLI answer.
func jsonStringField(t *testing.T, body, field string) string {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("the CLI answered with JSON: %v\n%s", err, body)
	}
	value, _ := decoded[field].(string)
	if value == "" {
		t.Fatalf("the CLI answer carries %q: %s", field, body)
	}
	return value
}

// mustReadFile reads a file a command was asked to write.
func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return body
}
