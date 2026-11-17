package acceptance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLiveRunKeepsItsEvidenceAndBlamesTheProductNotItsOwnPlumbing(t *testing.T) {
	if os.Getenv("VERIFY_GRAPH_LIVE") != "1" {
		t.Skip("set VERIFY_GRAPH_LIVE=1 to launch an isolated instance and run every journey")
	}
	root := verificationRoot(t)
	runID := "acceptance-" + strings.TrimPrefix(strconv.FormatInt(time.Now().UnixNano(), 36), "-")

	launch := func() map[string]any {
		stdout, stderr, code := runCLI(t, "launch", "--run", runID)
		if code != 0 {
			t.Skipf("this machine cannot launch an isolated instance (exit %d)\n%s\n%s", code, firstLine(stdout), firstLine(stderr))
		}
		return jsonObject(t, stdout)
	}
	launch()
	t.Cleanup(func() { runCLI(t, "cleanup", "--run", runID) })

	stdout, stderr, _ := runCLI(t, "verify", "--run", runID, "--all")
	if strings.TrimSpace(stdout) == "" {
		t.Fatalf("verify printed nothing; stderr: %s", firstLine(stderr))
	}
	envelope := jsonObject(t, stdout)
	if _, ok := envelope["data"].(map[string]any); !ok {
		t.Fatalf("verify envelope has no data object: %v", envelope["data"])
	}

	evidenceRoot := filepath.Join(root, "evidence", runID)
	if _, err := os.Stat(evidenceRoot); err != nil {
		t.Fatalf("verify left no evidence at %s: %v", evidenceRoot, err)
	}

	// Every assertions.json must blame the product, never the harness.
	checked := 0
	walkErr := filepath.WalkDir(evidenceRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Name() != "assertions.json" {
			return err
		}
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		var assertions []struct {
			ID     string `json:"id"`
			OK     bool   `json:"ok"`
			Actual string `json:"actual"`
		}
		if unmarshalErr := json.Unmarshal(payload, &assertions); unmarshalErr != nil {
			return unmarshalErr
		}
		for _, assertion := range assertions {
			checked++
			if assertion.OK {
				continue
			}
			for _, plumbing := range []string{"cannot write", "permission denied", "no such file or directory"} {
				if strings.Contains(assertion.Actual, plumbing) {
					t.Errorf("%s: assertion %s failed on the harness, not the product: %s", path, assertion.ID, assertion.Actual)
				}
			}
			if strings.TrimSpace(assertion.Actual) == "" {
				t.Errorf("%s: assertion %s failed without saying what it saw", path, assertion.ID)
			}
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("read the run's assertions: %v", walkErr)
	}
	if checked == 0 {
		t.Fatalf("the run recorded no assertion at all under %s", evidenceRoot)
	}

	stdout, _, code := runCLI(t, "evidence", "verify", "--run", runID)
	if code != 0 {
		t.Fatalf("evidence verify failed before cleanup (exit %d): %s", code, firstLine(stdout))
	}
	if _, _, code := runCLI(t, "cleanup", "--run", runID); code != 0 {
		t.Fatalf("cleanup failed (exit %d)", code)
	}
	stdout, _, code = runCLI(t, "evidence", "verify", "--run", runID)
	if code != 0 {
		t.Fatalf("cleanup ate the proof: evidence verify failed afterwards (exit %d): %s", code, firstLine(stdout))
	}
	t.Logf("run %s: %d assertions, evidence kept at %s", runID, checked, evidenceRoot)
}

// TestCleanupRemovesTheWholeRunDirectory pins the teardown contract: a run
// directory is removed as a unit, including directories no feature had yet
// invented when cleanup was written. The old cleanup deleted a hand-written
// list of children and left instance/ and window records behind.
func TestCleanupRemovesTheWholeRunDirectory(t *testing.T) {
	root := verificationRoot(t)
	runID := "acceptance-cleanup-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	dir := filepath.Join(root, ".run", runID)
	if err := os.MkdirAll(filepath.Join(dir, "instance", "state"), 0o755); err != nil {
		t.Fatalf("create fixture run: %v", err)
	}
	record := map[string]any{
		"runId": runID, "stateDir": filepath.Join(dir, "state"),
		"daemon": map[string]any{"pid": 0},
	}
	raw, _ := json.MarshalIndent(record, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "run.json"), raw, 0o644); err != nil {
		t.Fatalf("write run.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "instance", "leftover.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write leftover: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	stdout, stderr, code := runCLI(t, "cleanup", "--run", runID)
	if code != 0 {
		t.Fatalf("cleanup exited %d\nstdout: %s\nstderr: %s", code, firstLine(stdout), firstLine(stderr))
	}
	envelope := jsonObject(t, stdout)
	if envelope["ok"] != true {
		t.Fatalf("cleanup did not report success: %v", envelope)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("cleanup left %s behind (stat err: %v)", dir, err)
	}
}

// TestCleanupOrphansDryRunIsReadOnly proves the orphan path is reviewable
// before it acts: --dry-run returns the same decision it would execute, marks
// every entry dryRun or skipped, and removes nothing.
func TestCleanupOrphansDryRunIsReadOnly(t *testing.T) {
	stdout, stderr, code := runCLI(t, "cleanup", "--orphans", "--dry-run", "--older-than", "999999")
	if code != 0 {
		t.Fatalf("cleanup --orphans --dry-run exited %d\nstdout: %s\nstderr: %s", code, firstLine(stdout), firstLine(stderr))
	}
	envelope := jsonObject(t, stdout)
	data, _ := envelope["data"].(map[string]any)
	if data == nil {
		t.Fatalf("cleanup --orphans has no data object: %v", envelope)
	}
	if seconds, _ := data["olderThanSeconds"].(float64); int(seconds) != 999999 {
		t.Fatalf("olderThanSeconds = %v, want 999999", data["olderThanSeconds"])
	}
	entries, _ := data["orphans"].([]any)
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		if entry == nil {
			t.Fatalf("an orphan entry is not an object: %v", item)
		}
		if entry["removed"] == true || entry["stopped"] == true {
			t.Fatalf("a dry run acted on %v", entry)
		}
		if entry["dryRun"] != true && entry["skipped"] == nil {
			t.Fatalf("an entry is neither a dry-run target nor explained as skipped: %v", entry)
		}
	}
}

// TestTheWindowLaneDrivesSeveralStepsOnOneLiveDaemon is the regression for the
// two bugs that made "the window lane cannot do a multi-step journey" true:
// `ui window click` read run.json (which has no app pid) so every click after
// `open` answered "no window process"; and opening the window reparented the
// daemon to pid 1, which the app treats as launchd-supervised and stops before
// the window attaches. Both must stay fixed, because the real-window lane is
// where "a user can actually press this" is proven.
func TestTheWindowLaneDrivesSeveralStepsOnOneLiveDaemon(t *testing.T) {
	if os.Getenv("VERIFY_GRAPH_WINDOW") != "1" {
		t.Skip("set VERIFY_GRAPH_WINDOW=1 to open the real window and drive it through accessibility")
	}
	runID := "acceptance-window-" + strings.TrimPrefix(strconv.FormatInt(time.Now().UnixNano(), 36), "-")
	if stdout, stderr, code := runCLI(t, "launch", "--run", runID); code != 0 {
		t.Skipf("this machine cannot launch an isolated instance (exit %d)\n%s\n%s", code, firstLine(stdout), firstLine(stderr))
	}
	t.Cleanup(func() { runCLI(t, "cleanup", "--run", runID) })

	stdout, stderr, code := runCLI(t, "ui", "window", "open", "--run", runID)
	if code != 0 {
		// A machine without accessibility permission cannot judge this lane;
		// doctor (exit 3) is a different answer from a product failure.
		t.Skipf("cannot open the isolated window here (exit %d)\n%s\n%s", code, firstLine(stdout), firstLine(stderr))
	}
	opened := jsonObject(t, stdout)
	windowData, _ := opened["data"].(map[string]any)
	if windowData == nil || windowData["windowId"] == nil || windowData["windowId"] == "" {
		t.Fatalf("ui window open reported no windowId: %v", opened)
	}

	healthy := func(stage string) {
		t.Helper()
		stdout, _, code := runCLI(t, "api", "GET", "/api/health", "--run", runID)
		if code != 0 {
			t.Fatalf("the run's daemon is not healthy %s (exit %d): %s", stage, code, firstLine(stdout))
		}
	}
	healthy("before the first click")

	for _, target := range [][2]string{{"洞察", "洞察概览"}, {"编队", "编队"}} {
		stdout, stderr, code := runCLI(t, "ui", "window", "click", "--run", runID, "--name", target[0], "--expect", target[1])
		if code != 0 {
			t.Fatalf("clicking %q on the same window failed (exit %d)\n%s\n%s", target[0], code, firstLine(stdout), firstLine(stderr))
		}
		healthy("after clicking " + target[0])
	}

	stdout, _, code = runCLI(t, "ui", "window", "close", "--run", runID)
	if code != 0 {
		t.Fatalf("ui window close failed: %s", firstLine(stdout))
	}
	closed := jsonObject(t, stdout)
	closedData, _ := closed["data"].(map[string]any)
	if closedData == nil || closedData["daemonKept"] != true {
		t.Fatalf("closing the window must leave the daemon for the next verb: %v", closed)
	}
	healthy("after the window closed")
}
