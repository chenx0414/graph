package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A witness says "this control was really driven". It stops being true the
// moment its page is rebuilt: the button keeps the same name, so every other
// check passes, while the recorded run describes code that no longer exists.
//
// This is the shape that hid the deleted insights page: its `covered` verdict
// rested on a 2026-11-17 run, the page was deleted on 11-19, and the audit —
// which re-read the journey and the evidence and found both present — passed.
func TestAWitnessOlderThanItsPageIsStale(t *testing.T) {
	root := t.TempDir()
	page := writeStalenessPage(t, root, "rail.go")
	writeStalenessEvidence(t, root, "run-a", "rail", "2026-11-17T11:00:29Z")
	writeStalenessLedger(t, root, "rail")
	writeStalenessMap(t, root, "rail", "rail.go")

	// The page was last edited before the run was recorded: the claim holds.
	touch(t, page, mustTime(t, "2026-11-16T11:00:00Z"))
	if stale := staleWitnessPages(root, filepath.Join(root, "ledger.json"), filepath.Join(root, "app")); len(stale) > 0 {
		t.Fatalf("a run recorded after its page was last changed is not stale, got %v", stale)
	}

	// The page is edited; the recorded run does not move. The claim is now
	// about code that no longer exists.
	touch(t, page, mustTime(t, "2026-11-19T02:20:13Z"))
	stale := staleWitnessPages(root, filepath.Join(root, "ledger.json"), filepath.Join(root, "app"))
	if len(stale) != 1 {
		t.Fatalf("a witness older than its page must be reported once, got %v", stale)
	}
	for _, want := range []string{"rail", "rail.go", "2026-11-17"} {
		if !strings.Contains(stale[0], want) {
			t.Fatalf("the report names the page, the changed file and the run it rested on; missing %q in %q", want, stale[0])
		}
	}
}

// The comparison must not read file mtimes of the evidence: a git checkout
// rewrites them to "now", which would make every witness look fresh exactly
// where this check is needed. Only the run's own recorded time counts.
func TestEvidenceFreshnessComesFromTheRunNotFromTheCheckout(t *testing.T) {
	root := t.TempDir()
	page := writeStalenessPage(t, root, "rail.go")
	writeStalenessEvidence(t, root, "run-a", "rail", "2026-11-17T11:00:29Z")
	writeStalenessLedger(t, root, "rail")
	writeStalenessMap(t, root, "rail", "rail.go")

	// A fresh checkout: the evidence files carry today's mtime.
	touch(t, filepath.Join(root, "evidence", "run-a", "rail", "summary.json"), time.Now())
	touch(t, filepath.Join(root, "evidence", "run-a", "rail", "result.json"), time.Now())
	touch(t, page, mustTime(t, "2026-11-19T02:20:13Z"))

	if stale := staleWitnessPages(root, filepath.Join(root, "ledger.json"), filepath.Join(root, "app")); len(stale) != 1 {
		t.Fatalf("a touched evidence file must not launder a stale claim, got %v", stale)
	}
}

// Without a declared page→source mapping there is no honest answer, so the
// audit has to say that instead of guessing from control names: 「刷新」 and
// 「断开」 appear in a dozen files, and guessing marks unrelated pages stale.
func TestAPageWithNoDeclaredSourcesCannotBeJudged(t *testing.T) {
	root := t.TempDir()
	writeStalenessPage(t, root, "composer.go")
	writeStalenessEvidence(t, root, "run-a", "composer", "2026-11-17T11:00:29Z")
	writeStalenessLedger(t, root, "composer")
	writeStalenessMap(t, root, "rail", "rail.go")

	undecided := undeclaredPages(root, filepath.Join(root, "ledger.json"))
	if len(undecided) != 1 || !strings.Contains(undecided[0], "composer") {
		t.Fatalf("a page with no declared sources must be named, got %v", undecided)
	}
}

// A declaration pointing at a file that no longer exists is worse than none:
// the audit would silently judge the page against nothing.
func TestADeclaredSourceThatIsGoneIsReported(t *testing.T) {
	root := t.TempDir()
	writeStalenessPage(t, root, "rail.go")
	writeStalenessMap(t, root, "rail", "rail.go")
	writeStalenessMapEntry(t, root, "fleet", []string{"rail.go", "fleet_deleted.go"})

	problems := checkDeclaredSources(root, filepath.Join(root, "app"))
	if len(problems) != 1 || !strings.Contains(problems[0], "fleet_deleted.go") {
		t.Fatalf("a declared source that is gone must be named, got %v", problems)
	}
}

func writeStalenessPage(t *testing.T, root, name string) string {
	t.Helper()
	dir := filepath.Join(root, "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir app: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("write page: %v", err)
	}
	return path
}

func writeStalenessEvidence(t *testing.T, root, run, page, endedAt string) {
	t.Helper()
	dir := filepath.Join(root, "evidence", run, page)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir evidence: %v", err)
	}
	summary := `{"run":"` + run + `","lane":"headless","ok":true,"endedAt":"` + endedAt + `"}`
	if err := os.WriteFile(filepath.Join(dir, "summary.json"), []byte(summary), 0o644); err != nil {
		t.Fatalf("write summary: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "result.json"), []byte(`{"ok":true}`), 0o644); err != nil {
		t.Fatalf("write result: %v", err)
	}
}

func writeStalenessLedger(t *testing.T, root, page string) {
	t.Helper()
	body := `{"schema":1,"witnesses":[{"name":"轨迹","role":"button","page":"` + page + `","action":"click","journey":"nav","step":2}]}`
	if err := os.WriteFile(filepath.Join(root, "ledger.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write ledger: %v", err)
	}
}

func writeStalenessMap(t *testing.T, root, page, file string) {
	t.Helper()
	writeStalenessMapEntry(t, root, page, []string{file})
}

func writeStalenessMapEntry(t *testing.T, root, page string, files []string) {
	t.Helper()
	dir := filepath.Join(root, "controls")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir controls: %v", err)
	}
	path := filepath.Join(dir, "pages.json")
	existing := map[string][]string{}
	if raw, err := os.ReadFile(path); err == nil {
		var parsed struct {
			Pages map[string][]string `json:"pages"`
		}
		if json.Unmarshal(raw, &parsed) == nil && parsed.Pages != nil {
			existing = parsed.Pages
		}
	}
	existing[page] = files
	encoded, err := json.Marshal(map[string]any{"schema": 1, "pages": existing})
	if err != nil {
		t.Fatalf("encode map: %v", err)
	}
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		t.Fatalf("write page map: %v", err)
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return at
}

func touch(t *testing.T, path string, when time.Time) {
	t.Helper()
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatalf("touch %s: %v", path, err)
	}
}
