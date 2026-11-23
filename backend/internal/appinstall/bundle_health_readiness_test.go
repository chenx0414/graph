package appinstall

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A client treats the first successful /api/health as "the daemon is ready, reading it is
// meaningful". The catalog is filled after the listener is up, so between those moments health
// used to answer OK while the bootstrap definitions were still being published - measured on this
// packaged binary, 9 of 20 runs reported OK with 1, 2 or 3 of the 5 definitions. Any client that
// read the catalog on that signal got a half-built one, and the self-containment test above failed
// about as often.
func TestTheFirstHealthyAnswerCarriesTheWholeCatalog(t *testing.T) {
	root := repoRoot(t)
	binary := packagedBinary(t, root)
	sandbox := t.TempDir()
	home := filepath.Join(sandbox, "home")
	state := filepath.Join(sandbox, "state")
	graphHome := filepath.Join(sandbox, "graph-home")
	for _, directory := range []string{home, state, graphHome} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	port := freePort(t)
	process := exec.Command(binary, "daemon",
		"--state-dir", state, "--graph-home", graphHome, "--port", fmt.Sprint(port))
	process.Dir = sandbox
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
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		token := readToken(state)
		response, err := client.Get(base + "/api/health")
		if err != nil {
			time.Sleep(2 * time.Millisecond)
			continue
		}
		status := response.StatusCode
		_ = response.Body.Close()
		if status != http.StatusOK {
			// Not ready yet: the daemon has to keep saying so until the catalog is published.
			time.Sleep(2 * time.Millisecond)
			continue
		}
		if token == "" {
			t.Fatalf("health answered OK before the session token was written, so a client cannot read anything")
		}
		// This is the first healthy answer, and it must already mean ready.
		definitions := catalogDefinitions(t, client, base, token)
		for _, wanted := range []string{"master", "coder", "reviewer"} {
			if !definitions[wanted] {
				t.Fatalf("the first healthy answer came with an incomplete catalog (%v); health means listening, not ready\n%s", definitions, output.String())
			}
			return
		}
		return
	}
	t.Fatalf("the daemon never answered health:\n%s", output.String())
}

func readToken(stateDir string) string {
	raw, err := os.ReadFile(filepath.Join(stateDir, "session-token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func catalogDefinitions(t *testing.T, client *http.Client, base, token string) map[string]bool {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, base+"/api/catalog", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "graph_session", Value: token})
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("the catalog was not readable: %v", err)
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
	return found
}
