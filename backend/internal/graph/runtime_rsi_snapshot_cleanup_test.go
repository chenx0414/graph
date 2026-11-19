package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func rsiTestRepo(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, step := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "keeper@example.invalid"},
		{"config", "user.name", "keeper"},
	} {
		if result := Git(root, step, nil, nil); result.Code != 0 {
			t.Fatalf("git %v: %s", step, result.Stderr)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte("{\"name\":\"x\"}\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if result := Git(root, []string{"add", "package.json"}, nil, nil); result.Code != 0 {
		t.Fatalf("git add: %s", result.Stderr)
	}
	if result := Git(root, []string{"commit", "-q", "-m", "base"}, nil, nil); result.Code != 0 {
		t.Fatalf("git commit: %s", result.Stderr)
	}
	return root
}

func rsiTestWorktreeList(t *testing.T, root string) string {
	t.Helper()
	result := Git(root, []string{"worktree", "list", "--porcelain"}, nil, nil)
	if result.Code != 0 {
		t.Fatalf("worktree list: %s", result.Stderr)
	}
	return result.Stdout
}

func TestStaleSnapshotWhoseHolderIsGoneIsReaped(t *testing.T) {
	root := rsiTestRepo(t)
	dead := filepath.Join(filepath.Dir(root), "graph-async-full-deadholder")
	if result := Git(root, []string{"worktree", "add", "--detach", dead, "HEAD"}, nil, nil); result.Code != 0 {
		t.Fatalf("worktree add: %s", result.Stderr)
	}
	if result := Git(root, []string{"worktree", "lock", "--reason", "graph check running or queued (pid 999999)", dead}, nil, nil); result.Code != 0 {
		t.Fatalf("worktree lock: %s", result.Stderr)
	}

	rsiPruneStaleSnapshots(root)

	if strings.Contains(rsiTestWorktreeList(t, root), dead) {
		t.Fatalf("a snapshot whose check-queue holder (pid 999999) is gone still occupies the worktree list:\n%s", rsiTestWorktreeList(t, root))
	}
}

func TestAsyncFullRunKillsTheWholeProcessGroupOnTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("a real node process group and its timeout belong to the slow layer")
	}
	root := t.TempDir()
	pidFile := filepath.Join(root, "grandchild.pid")
	t.Setenv("GRAPH_TEST_GRANDCHILD_PID_FILE", pidFile)
	script := strings.Join([]string{
		"const fs=require('fs');",
		"const {spawn}=require('child_process');",
		"const child=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore'});",
		"fs.writeFileSync(process.env.GRAPH_TEST_GRANDCHILD_PID_FILE,String(child.pid));",
		"setTimeout(()=>{},600000);",
	}, "")

	result := rsiRunCommand(root, RsiCommand{Command: "node", Args: []string{"-e", script}}, 1500)
	if result.Status != "failed" {
		t.Fatalf("a run that outlives its deadline must fail: %+v", result)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("the run never recorded its grandchild: %v", err)
	}
	pid := strings.TrimSpace(string(raw))
	if pid == "" {
		t.Fatalf("the run recorded an empty grandchild pid")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if !rsiTestProcessAlive(t, pid) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the grandchild (pid %s) outlived the timed-out run: only the direct child was killed", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func rsiTestProcessAlive(t *testing.T, pid string) bool {
	t.Helper()
	probe := RsiCommand{Command: "node", Args: []string{"-e", "process.kill(Number(process.argv[1]),0)"}}
	probe.Args = append(probe.Args, pid)
	return rsiRunCommand(t.TempDir(), probe, 10000).Status == "passed"
}

func TestStaleScratchDirsAreReaped(t *testing.T) {
	stale := filepath.Join(os.TempDir(), "graph-scratch-stale-"+itoa(int(time.Now().UnixNano()%1e6)))
	fresh := filepath.Join(os.TempDir(), "graph-scratch-fresh-"+itoa(int(time.Now().UnixNano()%1e6)))
	for _, dir := range []string{stale, fresh} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(stale)
		_ = os.RemoveAll(fresh)
	})
	eightHoursAgo := time.Now().Add(-8 * time.Hour)
	if err := os.Chtimes(stale, eightHoursAgo, eightHoursAgo); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	rsiPruneStaleScratchDirs(time.Now())

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("a scratch directory untouched for 8 hours survived the reap: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("the reap took a scratch directory a running suite is still using: %v", err)
	}
}
