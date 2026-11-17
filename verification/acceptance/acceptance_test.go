// Package acceptance is the black-box contract test of the verification
// artifact itself: it runs ./verify-graph as a subprocess and asserts what a
// cold agent sees. It never imports the implementation.
package acceptance

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// verificationRoot is the directory holding verify-graph, go.mod and skills/.
func verificationRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "verify-graph")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no verify-graph entry point above %s", dir)
		}
		dir = parent
	}
}

func repoRoot(t *testing.T) string {
	return filepath.Dir(verificationRoot(t))
}

func runCLI(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	root := verificationRoot(t)
	command := exec.Command(filepath.Join(root, "verify-graph"), args...)
	command.Dir = root
	command.Env = append(os.Environ(), "VERIFY_GRAPH_ACCEPTANCE=1", "NO_COLOR=1")
	var stdout, stderr strings.Builder
	command.Stdout = &stdout
	command.Stderr = &stderr
	done := make(chan error, 1)
	if err := command.Start(); err != nil {
		t.Fatalf("cannot start verify-graph %v: %v", args, err)
	}
	go func() { done <- command.Wait() }()
	select {
	case <-time.After(180 * time.Second):
		_ = command.Process.Kill()
		t.Fatalf("verify-graph %v did not finish in 180s", args)
	case err := <-done:
		if err == nil {
			return stdout.String(), stderr.String(), 0
		}
		if exit, ok := err.(*exec.ExitError); ok {
			return stdout.String(), stderr.String(), exit.ExitCode()
		}
		t.Fatalf("verify-graph %v: %v", args, err)
	}
	return "", "", 0
}

// jsonObject returns the single JSON object a command printed to stdout.
func jsonObject(t *testing.T, stdout string) map[string]any {
	t.Helper()
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		t.Fatalf("stdout is empty; the command must print one JSON envelope")
	}
	if !strings.HasPrefix(trimmed, "{") {
		t.Fatalf("stdout does not start with a JSON object: %q", firstLine(trimmed))
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("stdout is not one JSON object (%v): %q", err, firstLine(trimmed))
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		t.Fatalf("stdout holds more than one JSON value; agents parse one line")
	}
	return value
}

func firstLine(s string) string {
	if index := strings.IndexByte(s, '\n'); index >= 0 {
		return s[:index]
	}
	return s
}

var commands = []string{
	"doctor", "build", "launch", "status", "ui",
	"api", "scenario", "verify", "evidence", "cleanup",
}

func helpText(t *testing.T) (string, int) {
	t.Helper()
	stdout, stderr, code := runCLI(t, "help")
	if code == 0 && strings.TrimSpace(stdout+stderr) != "" {
		return stdout + stderr, code
	}
	stdout, stderr, second := runCLI(t, "--help")
	return stdout + stderr, second
}

func TestHelpListsTheWholeCommandSurface(t *testing.T) {
	text, code := helpText(t)
	if code != 0 {
		t.Fatalf("verify-graph help exited %d; stdout+stderr: %s", code, text)
	}
	missing := []string{}
	for _, command := range commands {
		if !strings.Contains(text, command) {
			missing = append(missing, command)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("help does not list %s\nhelp output:\n%s", strings.Join(missing, ", "), text)
	}
}

func TestDoctorPrintsAnActionableEnvelope(t *testing.T) {
	stdout, stderr, code := runCLI(t, "doctor", "--json")
	envelope := jsonObject(t, stdout)
	if _, ok := envelope["ok"].(bool); !ok {
		t.Fatalf("doctor envelope has no boolean ok: %v", envelope)
	}
	command, _ := envelope["command"].(string)
	if !strings.Contains(command, "doctor") {
		t.Fatalf("doctor envelope names command %q", command)
	}
	switch code {
	case 0, 3:
	default:
		t.Fatalf("doctor exited %d; it may only exit 0 (usable) or 3 (environment)\nstderr: %s", code, stderr)
	}
	if code == 0 && envelope["ok"] != true {
		t.Fatalf("doctor exited 0 with ok=false: %v", envelope)
	}
	if envelope["ok"] == false {
		if code != 3 {
			t.Fatalf("doctor failed with exit %d; environment failures exit 3", code)
		}
		if hintOf(envelope) == "" {
			t.Fatalf("failed doctor gives no executable next step (hint/next): %v", envelope)
		}
	}
}

func hintOf(envelope map[string]any) string {
	errorValue, _ := envelope["error"].(map[string]any)
	for _, key := range []string{"hint", "next", "nextAction", "suggestion"} {
		if value, _ := errorValue[key].(string); strings.TrimSpace(value) != "" {
			return value
		}
	}
	for _, key := range []string{"nextActions", "warnings"} {
		if values, _ := envelope[key].([]any); len(values) > 0 {
			if text, _ := values[0].(string); strings.TrimSpace(text) != "" {
				return text
			}
		}
	}
	return ""
}

func TestUnknownCommandIsAUsageError(t *testing.T) {
	stdout, stderr, code := runCLI(t, "definitely-not-a-command")
	if code != 2 {
		t.Fatalf("unknown command exited %d, want 2\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	text := strings.TrimSpace(stdout)
	if text == "" {
		text = strings.TrimSpace(stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		t.Fatalf("usage error is not JSON: %q", firstLine(text))
	}
	if envelope["ok"] != false {
		t.Fatalf("usage error envelope has ok=%v", envelope["ok"])
	}
	if hintOf(envelope) == "" {
		t.Fatalf("usage error gives no next step: %v", envelope)
	}
}

var (
	h2Pattern       = regexp.MustCompile(`(?m)^## (.+?)\s*$`)
	skillCommand    = regexp.MustCompile("(?:^|[^a-zA-Z-])verify-graph[ \\t]+([a-z][a-z0-9-]*)")
	requiredFeature = []string{"Sub-features", "How to get to it (user POV)", "Gotchas"}
)

func canonicalSkillRoot(t *testing.T) string {
	t.Helper()
	root := verificationRoot(t)
	skillDir := filepath.Join(root, "skill", "verify-graph", "SKILL.md")
	skillsDir := filepath.Join(root, "skills", "verify-graph", "SKILL.md")
	_, skillErr := os.Stat(skillDir)
	_, skillsErr := os.Stat(skillsDir)
	switch {
	case skillErr == nil && skillsErr == nil:
		t.Fatalf("two skill copies exist (%s and %s); the artifact must publish exactly one", skillDir, skillsDir)
	case skillsErr == nil:
		return filepath.Dir(skillsDir)
	case skillErr == nil:
		return filepath.Dir(skillDir)
	default:
		t.Fatalf("no skill/verify-graph/SKILL.md under %s", root)
	}
	return ""
}

func TestSkillTeachesEveryMappedFeature(t *testing.T) {
	skillRoot := canonicalSkillRoot(t)
	body, err := os.ReadFile(filepath.Join(skillRoot, "SKILL.md"))
	if err != nil {
		t.Fatalf("read SKILL.md: %v", err)
	}
	if len(strings.TrimSpace(string(body))) < 400 {
		t.Fatalf("SKILL.md is too short to onboard a cold agent (%d bytes)", len(body))
	}
	featuresDir := filepath.Join(skillRoot, "features")
	entries, err := os.ReadDir(featuresDir)
	if err != nil {
		t.Fatalf("skill has no features directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(featuresDir, "README.md")); err != nil {
		t.Fatalf("features/README.md (the map index) is missing")
	}
	files := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") || entry.Name() == "README.md" {
			continue
		}
		files++
		path := filepath.Join(featuresDir, entry.Name())
		payload, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		text := string(payload)
		headings := map[string]bool{}
		for _, match := range h2Pattern.FindAllStringSubmatch(text, -1) {
			headings[strings.TrimSpace(match[1])] = true
		}
		for _, required := range requiredFeature {
			if !headings[required] {
				t.Fatalf("%s misses the H2 %q; every feature file uses the same four sections", entry.Name(), required)
			}
		}
		driving := false
		for heading := range headings {
			if strings.HasPrefix(heading, "Driving it with ") {
				driving = true
			}
		}
		if !driving {
			t.Fatalf("%s misses \"Driving it with <harness>\"", entry.Name())
		}
		if !strings.Contains(text, "verify-graph ") {
			t.Fatalf("%s has no verify-graph command a reader can run", entry.Name())
		}
	}
	if files < 3 {
		t.Fatalf("the feature map covers only %d features; the app has at least 7 rail modules", files)
	}
}

func TestSkillCommandsExistInHelp(t *testing.T) {
	skillRoot := canonicalSkillRoot(t)
	help, _ := helpText(t)
	seen := map[string]bool{}
	paths := []string{filepath.Join(skillRoot, "SKILL.md")}
	featuresDir := filepath.Join(skillRoot, "features")
	entries, _ := os.ReadDir(featuresDir)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md") {
			paths = append(paths, filepath.Join(featuresDir, entry.Name()))
		}
	}
	unknown := []string{}
	for _, path := range paths {
		payload, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, match := range skillCommand.FindAllStringSubmatch(string(payload), -1) {
			name := match[1]
			if seen[name] {
				continue
			}
			seen[name] = true
			if !strings.Contains(help, name) {
				unknown = append(unknown, name+" ("+filepath.Base(path)+")")
			}
		}
	}
	if len(unknown) > 0 {
		t.Fatalf("skill documents commands the CLI does not list: %s", strings.Join(unknown, ", "))
	}
}

func TestRepositoryBoundaryIsRespected(t *testing.T) {
	repo := repoRoot(t)
	command := exec.Command("git", "-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	outside := []string{}
	for _, record := range strings.Split(string(output), "\x00") {
		if len(record) < 4 {
			continue
		}
		path := record[3:]
		if !strings.HasPrefix(path, "verification/") {
			outside = append(outside, record[:3]+path)
		}
	}
	if len(outside) > 0 {
		t.Fatalf("the artifact touched files outside verification/:\n%s", strings.Join(outside, "\n"))
	}
}

// TestLiveRunKeepsItsEvidenceAndBlamesTheProductNotItsOwnPlumbing is the
// black-box end-to-end proof: it launches an isolated instance, runs every
// journey, then reads the evidence the run left behind. It is gated on
// VERIFY_GRAPH_LIVE=1 because it starts a real daemon.
//
// What it refuses to accept, and why:
//   - an assertion that failed because the harness could not write its own
//     evidence file ("cannot write ...") — that is a plumbing bug reported as a
//     product failure, and it must be fixed, never tolerated;
//   - evidence that does not survive cleanup, because a proof you delete is not
//     a proof;
//   - a run whose manifest no longer matches its files.
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
