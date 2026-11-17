package evidence

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readJSON(t *testing.T, path string, out any) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

func TestRecorderWritesAssertionsSummaryAndManifest(t *testing.T) {
	root := t.TempDir()
	recorder, err := NewRecorder(root, "run-1", "shell.settings")
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	if _, err := recorder.SaveJSON("api/settings.json", map[string]string{"project": "verify"}); err != nil {
		t.Fatalf("save json: %v", err)
	}
	if _, err := recorder.SaveText("ui/snapshot-labels.txt", "设置\n运行设置窗口\n"); err != nil {
		t.Fatalf("save text: %v", err)
	}
	shot, err := recorder.SaveBytes("ui/settings.png", KindScreenshot, []byte("\x89PNG\r\n"))
	if err != nil {
		t.Fatalf("save bytes: %v", err)
	}
	if shot.SHA256 == "" || shot.Bytes == 0 {
		t.Fatalf("artifact lacks digest: %+v", shot)
	}
	recorder.Assert(Assertion{ID: "settings-panel", OK: true, Expected: "运行设置窗口", Actual: "运行设置窗口"})
	recorder.Assert(Assertion{ID: "project-row", OK: true, Expected: "verify", Actual: "verify"})
	summary, err := recorder.Finish(FinishOptions{Scenario: "shell.settings"})
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	if !summary.OK || summary.Passed != 2 || summary.Failed != 0 {
		t.Fatalf("summary = %+v", summary)
	}

	var assertions AssertionFile
	readJSON(t, filepath.Join(recorder.Dir(), "assertions.json"), &assertions)
	if len(assertions.Assertions) != 2 || assertions.Run != "run-1" {
		t.Fatalf("assertions = %+v", assertions)
	}
	var manifest ManifestFile
	readJSON(t, filepath.Join(recorder.Dir(), "manifest.json"), &manifest)
	for _, name := range []string{"assertions.json", "summary.json", "api/settings.json", "ui/settings.png"} {
		if _, ok := manifest.Files[name]; !ok {
			t.Fatalf("manifest misses %s: %+v", name, manifest.Files)
		}
	}
	if problems, err := Verify(recorder.Dir()); err != nil || len(problems) != 0 {
		t.Fatalf("verify problems=%v err=%v", problems, err)
	}
}

func TestVerifyReportsTamperedAndUnlistedFiles(t *testing.T) {
	recorder, err := NewRecorder(t.TempDir(), "run-2", "fleet")
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	if _, err := recorder.SaveText("ui/labels.txt", "编队\n"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := recorder.Finish(FinishOptions{Scenario: "fleet"}); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if err := os.WriteFile(filepath.Join(recorder.Dir(), "ui/labels.txt"), []byte("篡改\n"), 0o644); err != nil {
		t.Fatalf("tamper: %v", err)
	}
	problems, err := Verify(recorder.Dir())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !containsProblem(problems, "ui/labels.txt") {
		t.Fatalf("tamper not reported: %v", problems)
	}
	recorder2, err := NewRecorder(t.TempDir(), "run-3", "fleet")
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	if _, err := recorder2.Finish(FinishOptions{Scenario: "fleet"}); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if err := os.WriteFile(filepath.Join(recorder2.Dir(), "extra.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("extra: %v", err)
	}
	problems, err = Verify(recorder2.Dir())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !containsProblem(problems, "extra.json") {
		t.Fatalf("unlisted file not reported: %v", problems)
	}
}

func TestPackKeepsManifestAndFiles(t *testing.T) {
	recorder, err := NewRecorder(t.TempDir(), "run-4", "insights")
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	if _, err := recorder.SaveText("ui/insights.txt", "洞察概览窗口\n"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := recorder.Finish(FinishOptions{Scenario: "insights"}); err != nil {
		t.Fatalf("finish: %v", err)
	}
	out := filepath.Join(t.TempDir(), "insights.tar.gz")
	artifact, err := Pack(recorder.Dir(), out)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	if artifact.Bytes == 0 {
		t.Fatalf("empty archive: %+v", artifact)
	}
	file, err := os.Open(out)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	archive := tar.NewReader(reader)
	found := map[string]bool{}
	for {
		header, err := archive.Next()
		if err != nil {
			break
		}
		found[header.Name] = true
	}
	for _, name := range []string{"manifest.json", "assertions.json", "ui/insights.txt"} {
		if !found[name] {
			t.Fatalf("archive misses %s: %v", name, found)
		}
	}
}

func TestSaveRejectsEscapingNames(t *testing.T) {
	recorder, err := NewRecorder(t.TempDir(), "run-5", "escape")
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	for _, name := range []string{"../escape.txt", "/tmp/escape.txt", "a/../../escape.txt"} {
		if _, err := recorder.SaveText(name, "x"); err == nil {
			t.Fatalf("%q must be rejected", name)
		}
	}
}

func TestSaveFileCopiesSourceAndHashesIt(t *testing.T) {
	source := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(source, []byte("pixels"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	recorder, err := NewRecorder(t.TempDir(), "run-6", "copy")
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	artifact, err := recorder.SaveFile(KindScreenshot, source)
	if err != nil {
		t.Fatalf("save file: %v", err)
	}
	if artifact.SHA256 != HashBytes([]byte("pixels")) || artifact.Bytes != 6 {
		t.Fatalf("artifact = %+v", artifact)
	}
	payload, err := os.ReadFile(filepath.Join(recorder.Dir(), artifact.Path))
	if err != nil || string(payload) != "pixels" {
		t.Fatalf("copied payload = %q err=%v", payload, err)
	}
}

func TestRedactPathsReplacesHomeAndSecrets(t *testing.T) {
	home := "/Users/someone"
	got := RedactPaths(home+"/Library/Application Support/Graph/state", home)
	if strings.Contains(got, "/Users/someone") || !strings.HasPrefix(got, "~") {
		t.Fatalf("home not redacted: %s", got)
	}
	kept := RedactPaths("/tmp/verify/state", home)
	if kept != "/tmp/verify/state" {
		t.Fatalf("unrelated path rewritten: %s", kept)
	}
	if RedactSecret("secret") != RedactSecret("secret") {
		t.Fatal("secret digest is not stable")
	}
	if strings.Contains(RedactSecret("secret"), "secret") {
		t.Fatal("secret leaked")
	}
}

func containsProblem(problems []string, fragment string) bool {
	for _, problem := range problems {
		if strings.Contains(problem, fragment) {
			return true
		}
	}
	return false
}

func TestSummarizeWritesFromExistingOutcomes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run-7", "ui.settings")
	summary, err := Summarize(dir, OutcomeFile{
		Scenario: "ui.settings",
		Run:      "run-7",
		Assertions: []Assertion{
			{ID: "settings.panel", OK: true},
			{ID: "settings.archive", OK: false, Expected: "归档 verify", Actual: "missing"},
		},
		Skipped: []Skip{{ID: "settings.models", Reason: "no model configured"}},
	})
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if summary.OK || summary.Passed != 1 || summary.Failed != 1 || len(summary.Skipped) != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
		t.Fatalf("manifest missing: %v", err)
	}
	if problems, err := Verify(dir); err != nil || len(problems) != 0 {
		t.Fatalf("verify: %v %v", problems, err)
	}
}
