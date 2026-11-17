package appinstance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fakeDesktop = `#!/bin/sh
state="$FAKE_DESKTOP_STATE"
counter="$state/clicked"
case "$1" in
  permissions)
    printf '%s\n' '{"version":"2.6","ok":true,"command":"permissions","data":{"accessibility":{"state":"granted"}}}'
    ;;
  list-windows)
    printf '%s\n' '{"version":"2.6","ok":true,"command":"list-windows","data":[{"pid":4242,"id":"w-1","app_name":"GraphVerify","title":"Graph","visible":false,"accessible":true,"bounds":{"x":10,"y":20,"width":1440,"height":900}},{"pid":9999,"id":"w-2","app_name":"Graph","title":"Graph","visible":true,"accessible":true,"bounds":{"x":0,"y":0,"width":100,"height":100}}]}'
    ;;
  find)
    if [ -f "$state/fail-once" ]; then
      rm -f "$state/fail-once"
      printf '%s\n' '{"version":"2.6","ok":false,"command":"find","error":{"code":"TIMEOUT","message":"inventory did not settle","disposition":{"delivery":"not_delivered","retry":"safe"}}}'
      exit 0
    fi
    printf '%s\n' '{"version":"2.6","ok":true,"command":"find","data":{"total_matches":1,"matches":[{"ref_id":"@s1:e1","role":"button","name":"洞察","interactive":true}]}}'
    ;;
  click)
    printf 'clicked %s\n' "$2" >> "$counter"
    printf '%s\n' '{"version":"2.6","ok":true,"command":"click","data":{"action":"click"}}'
    ;;
  snapshot)
    if [ -f "$counter" ]; then
      printf '%s\n' '{"version":"2.6","ok":true,"command":"snapshot","data":{"ref_count":3,"tree":{"role":"window","name":"Graph","children":[{"role":"button","name":"轨迹"},{"role":"button","name":"洞察"},{"role":"group","name":"洞察概览窗口"}]}}}'
    else
      printf '%s\n' '{"version":"2.6","ok":true,"command":"snapshot","data":{"ref_count":2,"tree":{"role":"window","name":"Graph","children":[{"role":"button","name":"轨迹"},{"role":"button","name":"洞察"}]}}}'
    fi
    ;;
  version)
    printf '%s\n' '{"version":"2.6","ok":true,"command":"version","data":{"version":"1.1.0","os":"macos"}}'
    ;;
  *)
    printf '%s\n' '{"version":"2.6","ok":false,"command":"'$1'","error":{"code":"INVALID_ARGS","message":"unsupported","disposition":{"retry":"unsafe"}}}'
    ;;
esac
`

func fakeDesktopBinary(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "agent-desktop")
	if err := os.WriteFile(path, []byte(fakeDesktop), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_DESKTOP_STATE", state)
	t.Setenv("GRAPH_DESKTOP_BIN", path)
	return path, state
}

func newTestInstance(t *testing.T) *Instance {
	t.Helper()
	repo := t.TempDir()
	root := filepath.Join(repo, "verification", ".run", "testrun")
	appBinary := filepath.Join(repo, "Graph")
	if err := os.WriteFile(appBinary, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	instance, err := New(Options{Repo: repo, Root: root, Mode: "view", AppBinary: appBinary})
	if err != nil {
		t.Fatal(err)
	}
	return instance
}

func TestWindowForPIDAvoidsTheUserInstance(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	desktop := instance.DesktopClient()

	window, err := desktop.WindowForPID(4242)
	if err != nil {
		t.Fatalf("window for our pid: %v", err)
	}
	if window.ID != "w-1" {
		t.Fatalf("must bind to the window of our own pid, got %+v", window)
	}
	user, err := desktop.WindowForPID(9999)
	if err != nil {
		t.Fatalf("the user window must still be visible to the tool: %v", err)
	}
	if user.ID == window.ID {
		t.Fatal("the two Graph windows must stay distinguishable by pid")
	}
	if _, err := desktop.WindowForPID(1); err == nil {
		t.Fatal("a pid without a window must be an error, not a silent fallback to another window")
	}
}

func TestFindAndClickThroughTheDesktop(t *testing.T) {
	_, state := fakeDesktopBinary(t)
	instance := newTestInstance(t)
	desktop := instance.DesktopClient()

	window, err := desktop.WindowForPID(4242)
	if err != nil {
		t.Fatal(err)
	}
	match, err := desktop.Click(window, "洞察")
	if err != nil {
		t.Fatalf("click: %v", err)
	}
	if match.Ref != "@s1:e1" {
		t.Fatalf("the click must use the ref the tool reported, got %+v", match)
	}
	clicked, err := os.ReadFile(filepath.Join(state, "clicked"))
	if err != nil {
		t.Fatalf("the fake desktop records clicks: %v", err)
	}
	if !strings.Contains(string(clicked), "@s1:e1") {
		t.Fatalf("the semantic ref must reach the CLI, got %q", clicked)
	}
}

func TestRetryOnlyWhenTheToolSaysSafe(t *testing.T) {
	_, state := fakeDesktopBinary(t)
	instance := newTestInstance(t)
	desktop := instance.DesktopClient()
	if err := os.WriteFile(filepath.Join(state, "fail-once"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.Find("w-1", "button", "洞察", true); err != nil {
		t.Fatalf("a refusal with disposition.retry=safe must be retried once: %v", err)
	}
}

func TestClickAndProveRecordsTheChange(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	if err := os.MkdirAll(instance.EvidenceDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	window, err := instance.DesktopClient().WindowForPID(4242)
	if err != nil {
		t.Fatal(err)
	}
	result, artifacts, err := instance.ClickAndProve(window, "洞察", "洞察概览", 5e9)
	if err != nil {
		t.Fatalf("click and prove: %v", err)
	}
	if !result.OK {
		t.Fatalf("the pane must show the insights title after the click, got expected=%q actual=%q hint=%q",
			result.Expected, result.Actual, result.Hint)
	}
	if len(artifacts) < 2 {
		t.Fatalf("the proof must leave the before and after accessibility dumps, got %d artifacts", len(artifacts))
	}
	for _, artifact := range artifacts {
		if artifact.SHA256 == "" {
			t.Fatalf("%s carries no digest", artifact.Path)
		}
		if _, err := os.Stat(artifact.Path); err != nil {
			t.Fatalf("%s must exist: %v", artifact.Path, err)
		}
	}
}

func TestClickAndProveFailsWhenNothingChanges(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	if err := os.MkdirAll(instance.EvidenceDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	window, err := instance.DesktopClient().WindowForPID(4242)
	if err != nil {
		t.Fatal(err)
	}
	result, _, err := instance.ClickAndProve(window, "轨迹", "永远不出现的面板", 1200e6)
	if err != nil {
		t.Fatalf("a missing pane is a failed assertion, not a transport error: %v", err)
	}
	if result.OK {
		t.Fatal("a click that changes nothing must fail the proof")
	}
	if result.Hint == "" {
		t.Fatal("a failed proof must say what to run next")
	}
}

func TestInstanceEnvironmentNeverTouchesTheUserState(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	if err := instance.prepare(); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	env := strings.Join(instance.Environment(), "\n")
	for _, expected := range []string{
		"HOME=" + instance.HomeDir(),
		"GRAPH_STATE_DIR=" + instance.StateDir(),
		"GRAPH_HOME=" + instance.GraphHome(),
		"GRAPH_DAEMON=" + instance.AppPath(),
	} {
		if !strings.Contains(env, expected) {
			t.Fatalf("the child environment must carry %q, got:\n%s", expected, env)
		}
	}
	if strings.Contains(env, "Application Support") || strings.Contains(env, "/.graph") {
		t.Fatalf("the child environment must not point at the user's Graph data:\n%s", env)
	}
	shim := filepath.Join(instance.ShimDir(), "launchctl")
	if _, err := os.Stat(shim); err != nil {
		t.Fatalf("the launchctl shim must exist before anything launches: %v", err)
	}
	payload, err := os.ReadFile(shim)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), "exit 1") {
		t.Fatalf("the shim must refuse every launchctl call, got %q", payload)
	}
	config, err := os.ReadFile(instance.ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Projects []struct {
			Root string `json:"root"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(config, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Projects) != 1 || !strings.HasPrefix(document.Projects[0].Root, instance.RunRoot()) {
		t.Fatalf("the generated config must point at the isolated project, got %s", string(config))
	}
}

func TestPrepareRefusesAMissingAppBinary(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	instance.AppBinary = filepath.Join(instance.RunRoot(), "missing", "Graph")
	if err := os.RemoveAll(instance.RunRoot()); err != nil {
		t.Fatal(err)
	}
	err := instance.prepare()
	if err == nil {
		t.Fatal("a missing app binary must fail the launch, not start nothing")
	}
	if !strings.Contains(err.Error(), "graphbuild app") {
		t.Fatalf("the error must name the command that builds the binary, got %v", err)
	}
}

func TestStatusReportsProblemsInsteadOfPretending(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	instance.AppPID = 1 << 22
	instance.DaemonPID = 0
	status := instance.Status()
	if status.AppAlive {
		t.Fatalf("a pid that is not alive must not be reported alive: %+v", status)
	}
	if len(status.Problems) == 0 {
		t.Fatal("a run with nothing alive must say so")
	}
}

func TestStopRefusesAProcessItDidNotStart(t *testing.T) {
	fakeDesktopBinary(t)
	instance := newTestInstance(t)
	marker := filepath.Join(instance.RunRoot(), "not-our-marker")
	if _, err := stopProcess(os.Getpid(), marker); err == nil {
		t.Fatal("stopping a process whose command line does not carry the run root must be refused")
	}
}

func TestUnnamedInteractiveNodesStayClickableButNeverMatchText(t *testing.T) {
	// A menu bar extra's root menuitem has a ref but no name; dropping it made
	// F-15 impossible to drive. Empty names must still never satisfy Contains,
	// because strings.Contains(name, "") is always true.
	raw := []byte(`{"role":"menu","children":[
		{"role":"menuitem","ref_id":"@x:e1","children":[
			{"role":"menu","name":"Graph","children":[
				{"role":"menuitem","name":"打开 Graph","ref_id":"@x:e2"}
			]}
		]}
	]}`)
	nodes := []Node{}
	collectNodes(raw, &nodes)
	foundUnnamed := false
	for _, node := range nodes {
		if node.Name == "" && node.Ref == "@x:e1" {
			foundUnnamed = true
		}
	}
	if !foundUnnamed {
		t.Fatalf("the unnamed menu item was dropped: %+v", nodes)
	}
	snapshot := Snapshot{Nodes: nodes}
	if snapshot.Contains("") {
		t.Fatal("an empty needle must never match every node")
	}
	if !snapshot.Contains("打开 Graph") {
		t.Fatal("named menu items are still searchable")
	}
	for _, name := range snapshot.Names() {
		if name == "" {
			t.Fatalf("Names() must not include empty entries: %+v", snapshot.Names())
		}
	}
}
