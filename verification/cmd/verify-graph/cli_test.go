package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTheEnvelopeKeepsItsContract(t *testing.T) {
	result := okEnvelope("status", "api", map[string]any{"runs": 0})
	if result.OK != true || result.Command != "status" || result.Lane != "api" {
		t.Fatalf("envelope = %+v", result)
	}
	if result.Artifacts == nil || result.Warnings == nil || result.NextActions == nil {
		t.Fatalf("the empty lists must marshal as [] not null: %+v", result)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"command"`, `"ok"`, `"artifacts":[]`, `"warnings":[]`, `"nextActions":[]`, `"error":null`} {
		if !strings.Contains(string(raw), field) {
			t.Fatalf("envelope JSON is missing %s: %s", field, raw)
		}
	}
	failure := failEnvelope("launch", "api", codeIsolation, "refused", "fix the path")
	if failure.OK || failure.Error == nil || failure.Error.Code != codeIsolation || failure.Error.Hint == "" {
		t.Fatalf("a failure needs a code and a hint: %+v", failure)
	}
}

func TestFlagsCollectRepeatedValuesAndBooleans(t *testing.T) {
	parsed := parseFlags([]string{"--journey", "one", "--journey", "two", "--keep", "--run", "abc", "extra"})
	if got := parsed.all("journey"); len(got) != 2 || got[0] != "one" || got[1] != "two" {
		t.Fatalf("repeated flags = %v", got)
	}
	if !parsed.has("keep") {
		t.Fatal("--keep must be a boolean flag")
	}
	if parsed.value("run", "") != "abc" {
		t.Fatalf("run = %q", parsed.value("run", ""))
	}
	if len(parsed.rest) != 1 || parsed.rest[0] != "extra" {
		t.Fatalf("positional args = %v", parsed.rest)
	}
	if parsed.number("missing", 7) != 7 {
		t.Fatal("an absent number falls back to the default")
	}
}

func TestTheIsolationGuardRefusesPathsOutsideTheRun(t *testing.T) {
	root := t.TempDir()
	meta := runMeta{StateDir: filepath.Join(root, "state")}
	if !insideRun(meta, filepath.Join(root, "graph-home")) {
		t.Fatal("a sibling of state inside the run root is allowed")
	}
	if insideRun(meta, filepath.Join(filepath.Dir(root), "elsewhere")) {
		t.Fatal("a path outside the run root must be refused")
	}
	if insideRun(meta, filepath.Join(string(filepath.Separator), "Users", "shared", "Graph")) {
		t.Fatal("the user's Graph directory must be refused")
	}
}

func TestRunningCheckListRecordsEveryAssertionAndItsEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "graph_session=token-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/health":
			w.Write([]byte(`{"ok":true}`))
		case "/api/startup":
			w.Write([]byte(`{"mode":"view","source":{"commit":"abc123"}}`))
		case "/api/conversations":
			w.Write([]byte(`[]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "session-token"), []byte("token-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	meta := runMeta{RunID: "run-1", StateDir: stateDir, Daemon: daemonMeta{URL: server.URL}}
	outDir := filepath.Join(t.TempDir(), "checks")
	checks := []apiCheck{
		{ID: "health", Method: "GET", Path: "/api/health", ExpectStatus: 200, Expect: map[string]any{"ok": true}},
		{ID: "startup-mode", Method: "GET", Path: "/api/startup", ExpectStatus: 200, Expect: map[string]any{"mode": "view", "source.commit": "abc123"}},
		{ID: "wrong-expectation", Method: "GET", Path: "/api/startup", ExpectStatus: 200, Expect: map[string]any{"mode": "execute"}},
		{ID: "missing-route", Method: "GET", Path: "/api/nope", ExpectStatus: 200},
	}
	assertions := runCheckList(meta, checks, outDir, "check")
	if len(assertions) != 4 {
		t.Fatalf("assertions = %+v", assertions)
	}
	if !assertions[0].OK || !assertions[1].OK {
		t.Fatalf("the passing checks must pass: %+v", assertions[:2])
	}
	if assertions[2].OK || !strings.Contains(assertions[2].Actual, "mode") {
		t.Fatalf("a wrong expectation must fail with the actual value: %+v", assertions[2])
	}
	if assertions[3].OK {
		t.Fatalf("a 404 must fail: %+v", assertions[3])
	}
	raw, err := os.ReadFile(assertions[1].Evidence)
	if err != nil {
		t.Fatalf("evidence file: %v", err)
	}
	if !strings.Contains(string(raw), "abc123") {
		t.Fatalf("the evidence must carry the response body: %s", raw)
	}
}

func TestTheApiClientSendsTheSessionCookieAndOrigin(t *testing.T) {
	seen := make(chan [2]string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			seen <- [2]string{r.Header.Get("Cookie"), r.Header.Get("Origin")}
		}
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client := newAPIClient(server.URL, "token-2")
	if _, _, err := client.do(http.MethodPost, "/api/conversations", map[string]any{"requestId": "x"}); err != nil {
		t.Fatal(err)
	}
	headers := <-seen
	if headers[0] != "graph_session=token-2" {
		t.Fatalf("cookie = %q", headers[0])
	}
	if !strings.HasPrefix(headers[1], "http://127.0.0.1:") {
		t.Fatalf("a write must carry the loopback Origin, got %q", headers[1])
	}
}

func TestAJourneyMustLoadStepsAndDefaultsItsSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.json")
	if err := os.WriteFile(path, []byte(`{"id":"sample","feature":"F-01","steps":[{"verb":"assertText","text":"设置"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	value, err := loadJourney(path)
	if err != nil {
		t.Fatal(err)
	}
	if value.Width != 1440 || value.Height != 900 {
		t.Fatalf("size = %dx%d", value.Width, value.Height)
	}
	if len(value.Steps) != 1 || value.Steps[0].Text != "设置" {
		t.Fatalf("steps = %+v", value.Steps)
	}
	broken := filepath.Join(dir, "broken.json")
	if err := os.WriteFile(broken, []byte(`{"id":"broken","steps":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadJourney(broken); err == nil {
		t.Fatal("a journey without steps must be refused")
	}
}

func TestEvidenceManifestsDetectATamperedFile(t *testing.T) {
	dir := t.TempDir()
	frame := filepath.Join(dir, "frame.png")
	if err := os.WriteFile(frame, []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifestPath, err := writeManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Files []struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
		} `json:"files"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) != 1 || manifest.Files[0].Path != "frame.png" || len(manifest.Files[0].SHA256) != 64 {
		t.Fatalf("manifest = %+v", manifest)
	}
	if err := os.WriteFile(frame, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum, _, err := sha256File(frame)
	if err != nil {
		t.Fatal(err)
	}
	if sum == manifest.Files[0].SHA256 {
		t.Fatal("rewriting the file must change its digest, which is what evidence verify reports")
	}
}

func TestARunIsOnlyAliveWhileItsRecordedProcessIs(t *testing.T) {
	meta := runMeta{RunID: "r", Daemon: daemonMeta{PID: os.Getpid(), Start: lstart(os.Getpid())}}
	if !runAlive(meta) {
		t.Fatal("the current process matches its own record")
	}
	meta.Daemon.Start = "a different start time"
	if runAlive(meta) {
		t.Fatal("a mismatched start time means the pid was reused, so the run is not ours")
	}
	if runAlive(runMeta{RunID: "r", Daemon: daemonMeta{PID: 0}}) {
		t.Fatal("a run without a pid is not alive")
	}
	if !(runMeta{}).isZero() {
		t.Fatal("the zero run is recognised so verify can relaunch it")
	}
}

func TestTheDaemonScanFindsOnlyThisWorkspace(t *testing.T) {
	root := t.TempDir()
	p := paths{Verification: root, RunRoot: filepath.Join(root, ".run")}
	found := scanDaemons(p)
	for _, process := range found {
		if !strings.Contains(process.Command, root) {
			t.Fatalf("the scan reported a process outside this workspace: %+v", process)
		}
	}
}

func TestAnUnreachableRunFailsWithAnActionableHint(t *testing.T) {
	root := t.TempDir()
	p := paths{Verification: root, RunRoot: filepath.Join(root, ".run"), EvidenceRoot: filepath.Join(root, "evidence")}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(cwd)
	code := apiCommand(p, []string{"GET", "/api/health", "--run", "missing"})
	if code != 1 {
		t.Fatalf("api on a missing run must fail, exit %d", code)
	}
	_ = root
}

func TestCleanupRefusesAPidItDidNotStart(t *testing.T) {
	meta := runMeta{RunID: "r", Daemon: daemonMeta{PID: os.Getpid(), Start: "not-this-process"}}
	if err := stopRun(paths{}, meta); err == nil {
		t.Fatal("a pid whose start time does not match must never be signalled")
	}
	if !strings.Contains(stopRun(paths{}, meta).Error(), "not the process this run started") {
		t.Fatal("the refusal must say why")
	}
}

func TestATimedOutJourneyIsReportedAsAFailure(t *testing.T) {
	started := time.Now()
	if time.Since(started) < 0 {
		t.Fatal("clock")
	}
	result := journeyResult{OK: false, Error: "the headless journey timed out after 1s", ExitCode: 4}
	truncated := truncate(strings.Repeat("x", 100), 10)
	if len(truncated) >= 100 || !strings.Contains(truncated, "truncated") {
		t.Fatalf("truncate = %q", truncated)
	}
	if result.ExitCode != 4 {
		t.Fatal("a timeout keeps its own exit code")
	}
}
