package graph

import (
	"os"
	"path/filepath"
	"testing"
)

func withoutNode(t *testing.T) map[string]string {
	t.Helper()
	emptyDir := t.TempDir()
	return map[string]string{RUNTIME_NODE_ENV: "", "PATH": emptyDir, "HOME": t.TempDir()}
}

func TestNodeRuntimeNeverFallsBackToTheGraphBinary(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	execPath, electron := GraphNodeRuntime(withoutNode(t))
	if execPath == self {
		t.Fatal("the Graph binary was handed out as the node runtime; the command would run the daemon instead of node")
	}
	if execPath != "" || electron != "" {
		t.Fatalf("a missing node runtime must be reported as missing, got %q (electron %q)", execPath, electron)
	}
}

func TestACapabilityThatNeedsNodeRefusesToResolve(t *testing.T) {
	previous := os.Getenv(RUNTIME_NODE_ENV)
	previousPath := os.Getenv("PATH")
	if err := os.Setenv(RUNTIME_NODE_ENV, filepath.Join(t.TempDir(), "no-node")); err != nil {
		t.Fatal(err)
	}
	if err := os.Setenv("PATH", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.Setenv(RUNTIME_NODE_ENV, previous)
		_ = os.Setenv("PATH", previousPath)
	}()

	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("a capability resolved to an empty node path instead of refusing")
		}
		_, code, message, _ := PublicError(recovered)
		if code == "" || !containsStringText(message, "node") {
			t.Fatalf("the refusal does not explain the missing runtime: %q %q", code, message)
		}
	}()
	capabilityResolveRuntimeCommand("node", t.TempDir())
}

func TestTheMissingNodeExplanationNamesTheEnvironmentVariable(t *testing.T) {
	message := MissingNodeRuntime("run a module").Error()
	if message == "" {
		t.Fatal("the missing runtime error has no message")
	}
	for _, want := range []string{RUNTIME_NODE_ENV, "node"} {
		if !containsStringText(message, want) {
			t.Fatalf("the explanation does not mention %q: %q", want, message)
		}
	}
}

func containsStringText(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || len(needle) == 0 ||
		indexOfText(haystack, needle) >= 0)
}

func indexOfText(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
