package appinstall

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func packagedBinary(t *testing.T, root string) string {
	t.Helper()
	for _, candidate := range []string{
		filepath.Join(root, "app", "build", "darwin-arm64", "Graph.app", "Contents", "MacOS", "Graph"),
		filepath.Join(root, "dist", "app", "mac-arm64", "Graph.app", "Contents", "MacOS", "Graph"),
	} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	t.Skip("no packaged Graph.app binary in this checkout; run `go -C backend run ./cmd/graphbuild app` first")
	return ""
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

func awaitHealth(t *testing.T, base string, process *exec.Cmd, output *strings.Builder) {
	t.Helper()
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(base + "/api/health")
		if err == nil {
			status := response.StatusCode
			_ = response.Body.Close()
			if status == http.StatusOK {
				return
			}
		}
		if process.ProcessState != nil && process.ProcessState.Exited() {
			t.Fatalf("the daemon exited before serving health:\n%s", output.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the daemon never served /api/health:\n%s", output.String())
}

func TestThePackagedBinaryRunsWithNoExternalAssets(t *testing.T) {
	root := repoRoot(t)
	binary := packagedBinary(t, root)
	sandbox := t.TempDir()
	home := filepath.Join(sandbox, "home")
	workingDir := filepath.Join(sandbox, "cwd")
	for _, directory := range []string{home, workingDir, filepath.Join(sandbox, "state"), filepath.Join(sandbox, "graph-home")} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	stateDir := filepath.Join(sandbox, "state")
	graphHome := filepath.Join(sandbox, "graph-home")
	port := freePort(t)

	process := exec.Command(binary, "daemon",
		"--state-dir", stateDir, "--graph-home", graphHome, "--port", fmt.Sprint(port))
	process.Dir = workingDir
	process.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR=" + sandbox}
	var output strings.Builder
	process.Stdout = &output
	process.Stderr = &output
	if err := process.Start(); err != nil {
		t.Fatalf("the packaged binary could not start: %v", err)
	}
	defer func() {
		_ = process.Process.Kill()
		_, _ = process.Process.Wait()
	}()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	awaitHealth(t, base, process, &output)

	token, err := os.ReadFile(filepath.Join(stateDir, "session-token"))
	if err != nil {
		t.Fatalf("the daemon did not write a session token: %v\n%s", err, output.String())
	}
	request, err := http.NewRequest(http.MethodGet, base+"/api/catalog", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "graph_session", Value: strings.TrimSpace(string(token))})
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("the catalog was not readable: %v\n%s", err, output.String())
	}
	defer func() { _ = response.Body.Close() }()
	var catalog struct {
		Definitions []struct {
			Id string `json:"id"`
		} `json:"definitions"`
	}
	if err := json.NewDecoder(response.Body).Decode(&catalog); err != nil {
		t.Fatalf("the catalog payload did not decode: %v", err)
	}
	found := map[string]bool{}
	for _, definition := range catalog.Definitions {
		found[definition.Id] = true
	}
	for _, wanted := range []string{"master", "coder", "reviewer", "tester"} {
		if !found[wanted] {
			t.Fatalf("the bootstrap definition %q is missing; the embedded preset pack did not reach the catalog (%v)\n%s", wanted, found, output.String())
		}
	}
	if strings.Contains(output.String(), "Bootstrap preset pack not available") {
		t.Fatalf("the daemon reported a missing preset pack while the embedded copy should have covered it:\n%s", output.String())
	}
}

func TestThePackagedBinaryCarriesItsRuntimeScripts(t *testing.T) {
	root := repoRoot(t)
	binary := packagedBinary(t, root)
	sandbox := t.TempDir()
	graphHome := filepath.Join(sandbox, "graph-home")
	stateDir := filepath.Join(sandbox, "state")
	for _, directory := range []string{graphHome, stateDir} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	port := freePort(t)
	process := exec.Command(binary, "daemon",
		"--state-dir", stateDir, "--graph-home", graphHome, "--port", fmt.Sprint(port))
	process.Dir = sandbox
	process.Env = []string{"HOME=" + filepath.Join(sandbox, "home"), "PATH=/usr/bin:/bin", "TMPDIR=" + sandbox}
	var output strings.Builder
	process.Stdout = &output
	process.Stderr = &output
	if err := process.Start(); err != nil {
		t.Fatalf("the packaged binary could not start: %v", err)
	}
	defer func() {
		_ = process.Process.Kill()
		_, _ = process.Process.Wait()
	}()
	awaitHealth(t, fmt.Sprintf("http://127.0.0.1:%d", port), process, &output)

	for _, name := range []string{"check-resolver.cjs", "module-worker.mjs"} {
		path := filepath.Join(graphHome, "assets", "runtime", name)
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s was not extracted from the binary into %s: %v", name, graphHome, err)
		}
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	absolute, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}
