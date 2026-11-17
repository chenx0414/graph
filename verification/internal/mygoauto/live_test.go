package mygoauto

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func liveOptions(t *testing.T) Options {
	t.Helper()
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	verification, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	run := filepath.Join(verification, ".run", fmt.Sprintf("live-%d", time.Now().UnixNano()))
	return Options{RunDir: run, RepoRoot: repo, SourceRoot: repo, ReadyTimeout: 120 * time.Second}
}

func TestLiveDrivesTheRealWindow(t *testing.T) {
	if os.Getenv("GRAPH_LIVE") != "1" {
		t.Skip("set GRAPH_LIVE=1 to build the e2e app and drive a real window")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	opts := liveOptions(t)
	session, err := Launch(ctx, opts)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	closed := false
	defer func() {
		if !closed {
			if err := session.Close(ctx); err != nil {
				t.Logf("close: %v", err)
			}
		}
	}()

	t.Logf("run %s console %s window %d build %s", opts.RunDir, session.ConsoleURL(), session.Window(), session.Build().SHA256[:12])
	if session.record.Replacements != 1 || len(session.record.OverlayFiles) != 1 {
		t.Fatalf("the build must add exactly one file to app/: %+v", session.record)
	}

	tree, err := session.Tree(ctx)
	if err != nil {
		t.Fatalf("tree: %v", err)
	}
	if _, err := session.SaveEvidence("tree-boot.json", tree); err != nil {
		t.Fatal(err)
	}
	t.Logf("boot tree: %d elements, %d labels", len(tree), len(tree.Labels()))

	rail := []string{"轨迹", "洞察", "编队", "供应商", "资源", "装配", "设置"}
	found := 0
	for _, label := range rail {
		if _, err := tree.Find(Sel{Role: "button", Label: label}); err == nil {
			found++
		} else {
			t.Logf("missing rail button %s: %v", label, err)
		}
	}
	if found != len(rail) {
		t.Fatalf("rail buttons: found %d of %d; labels are %v", found, len(rail), tree.Labels())
	}

	target, err := session.Resolve(Sel{Role: "button", Label: "洞察"})
	if err != nil {
		t.Fatalf("resolve 洞察: %v", err)
	}
	if err := session.Act(ctx, target.ID, "press", ""); err != nil {
		t.Fatalf("press 洞察: %v", err)
	}
	after, err := session.Tree(ctx)
	if err != nil {
		t.Fatalf("tree after press: %v", err)
	}
	added, removed := Diff(tree, after)
	if _, err := session.SaveEvidence("tree-insight.json", after); err != nil {
		t.Fatal(err)
	}
	if len(added)+len(removed) == 0 {
		t.Fatalf("pressing 洞察 changed nothing in the accessibility tree; labels are %v", after.Labels())
	}
	t.Logf("press 洞察: +%d -%d elements", len(added), len(removed))

	insightNodes := after.Contain("洞察")
	labels := []string{}
	for _, node := range insightNodes {
		labels = append(labels, node.Role+" "+node.Label)
	}
	if _, err := session.SaveEvidence("insight-labels.json", labels); err != nil {
		t.Fatal(err)
	}
	if len(insightNodes) < 2 {
		t.Fatalf("the 洞察 page should show more than the rail button itself, got %v", labels)
	}

	shot := filepath.Join(opts.RunDir, "evidence", "insight.png")
	rect, frontmost, err := session.Screenshot(shot)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if !frontmost {
		t.Logf("another app was in front of the window at capture time; the PNG may show that app")
	}
	info, err := os.Stat(shot)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("screenshot %s %dx%d %d bytes", shot, int(rect.Width), int(rect.Height), info.Size())

	status, payload, err := session.Get("/api/health")
	if err != nil || status != 200 || !strings.Contains(string(payload), "ok") {
		t.Fatalf("daemon health: %d %s %v", status, payload, err)
	}
	if _, err := session.SaveEvidence("health.json", map[string]any{"status": status, "body": string(payload), "console": session.ConsoleURL()}); err != nil {
		t.Fatal(err)
	}

	if err := session.VerifyGlobal(); err != nil {
		t.Fatalf("global state: %v", err)
	}
	report := session.GlobalReport()
	if _, err := session.SaveGlobalReport(); err != nil {
		t.Fatal(err)
	}
	t.Logf("global unchanged=%v launchctl calls=%q", report.Unchanged, report.LaunchctlLog)

	if err := session.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	closed = true
	if processAlive(session.Status().AppPID) || processAlive(session.Status().DaemonPID) {
		t.Fatal("cleanup left a process behind")
	}
	if _, err := os.Stat(shot); err != nil {
		t.Fatalf("cleanup must keep the evidence: %v", err)
	}
}
