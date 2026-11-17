package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"graph/verification/internal/controls"
)

func writeTestJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAddAXFileKeepsOnlyNamedInteractiveControls(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ax.json")
	writeTestJSON(t, path, map[string]any{
		"windowId": "w1",
		"nodes": []map[string]any{
			{"name": "洞察", "role": "button", "bounds": map[string]any{"x": 1, "y": 2, "width": 30, "height": 40}},
			{"name": "一段普通文字", "role": "text"},
			{"name": "消息", "role": "textfield"},
			{"name": "打开 Graph", "role": "menuitem"},
			{"name": "分组", "role": "group"},
			{"name": "", "role": "button"},
			{"name": "洞察", "role": "button"}, // duplicate instance
		},
	})
	inventory := controls.Inventory{}
	added, err := addAXFile(&inventory, path, "rail", "F-02")
	if err != nil {
		t.Fatal(err)
	}
	if added != 3 {
		t.Fatalf("added = %d, controls = %+v", added, inventory.Controls)
	}
	inventory = controls.Normalize(inventory)
	byName := map[string]controls.Control{}
	for _, control := range inventory.Controls {
		byName[control.Name] = control
	}
	if byName["洞察"].Bounds == nil || byName["洞察"].Bounds.Width != 30 {
		t.Fatalf("bounds were not kept: %+v", byName["洞察"])
	}
	if byName["打开 Graph"].Requires != "window" {
		t.Fatalf("a menu item must require the window/menu lane: %+v", byName["打开 Graph"])
	}
	if len(inventory.Controls) != 3 {
		t.Fatalf("duplicate was not collapsed: %+v", inventory.Controls)
	}
}

func TestAddEvidenceRunsSkipsHeadlessAndRedRuns(t *testing.T) {
	root := t.TempDir()
	write := func(run, feature string, ok bool, lane string, nodes ...map[string]any) {
		access := []map[string]any{}
		access = append(access, nodes...)
		writeTestJSON(t, filepath.Join(root, run, feature, "result.json"), map[string]any{
			"ok": ok, "lane": lane, "access": access,
		})
	}
	write("run-window", "F-02", true, "window",
		map[string]any{"name": "洞察", "role": "button"},
		map[string]any{"name": "Close", "role": "button"},
		map[string]any{"name": "关闭", "role": "button"},
	)
	write("run-headless", "F-03", true, "headless", map[string]any{"name": "设置", "role": "button"})
	write("run-red", "F-04", false, "window", map[string]any{"name": "资源", "role": "button"})

	inventory := controls.Inventory{}
	if _, _, err := addEvidenceRuns(&inventory, root, nil); err != nil {
		t.Fatal(err)
	}
	inventory = controls.Normalize(inventory)
	if len(inventory.Controls) != 3 {
		t.Fatalf("a headless or red run must not contribute controls: %+v", inventory.Controls)
	}
	pages := map[string]string{}
	for _, control := range inventory.Controls {
		pages[control.Name] = control.Page
	}
	if pages["洞察"] != "rail" || pages["Close"] != "window" || pages["关闭"] != "F-02" {
		t.Fatalf("stable page attribution = %v", pages)
	}
}

func TestCoverAuditTurnsRedThenGreenWhenAControlGetsAWitness(t *testing.T) {
	root := t.TempDir()
	p := paths{Verification: root, EvidenceRoot: filepath.Join(root, "evidence")}
	writeTestJSON(t, filepath.Join(root, "scenarios", "F-02-nav.json"), map[string]any{
		"id": "F-02-nav", "feature": "F-02",
		"steps": []map[string]any{
			{"verb": "click", "name": "洞察"},
			{"verb": "waitText", "text": "洞察概览窗口"},
		},
	})
	writeTestJSON(t, filepath.Join(root, "evidence", "run1", "F-02", "result.json"), map[string]any{
		"ok": true, "lane": "window",
		"steps": []map[string]any{
			{"index": 1, "verb": "click", "ok": true},
			{"index": 2, "verb": "waitText", "ok": true},
		},
	})
	writeTestJSON(t, filepath.Join(root, "evidence", "run1", "F-02", "summary.json"), map[string]any{
		"ok": true, "lane": "window",
	})
	writeTestJSON(t, filepath.Join(root, "controls", "inventory.json"), controls.Inventory{
		Schema: 1,
		Controls: []controls.Control{
			{Name: "洞察", Role: "button", Page: "rail", Feature: "F-02"},
		},
	})
	// No ledger yet: the audit must not silently pass.
	if code := coverAudit(p, parseFlags(nil)); code == 0 {
		t.Fatal("an audit without a ledger must be red")
	}
	if code := coverAudit(p, parseFlags([]string{"--ledger", filepath.Join(root, "missing.json")})); code != 1 {
		t.Fatalf("a missing ledger exited %d, want 1", code)
	}
	writeTestJSON(t, filepath.Join(root, "controls", "ledger.json"), controls.Ledger{
		Schema: 1,
		Witnesses: []controls.Witness{
			{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"},
		},
	})
	if code := coverAudit(p, parseFlags(nil)); code != 0 {
		t.Fatalf("a proved witness must make the audit green, exit %d", code)
	}
	raw, err := os.ReadFile(filepath.Join(root, "controls", "coverage.json"))
	if err != nil {
		t.Fatal(err)
	}
	var report controls.Report
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	if report.Covered != 1 || report.Total != 1 || !report.OK() {
		t.Fatalf("coverage.json = %+v", report)
	}
}

func TestCoverCommandRefusesAnUnknownVerb(t *testing.T) {
	p := paths{Verification: t.TempDir()}
	if code := coverCommand(p, []string{"definitely-not-a-verb"}); code != 2 {
		t.Fatalf("unknown cover verb exited %d, want a usage error (2)", code)
	}
}

func TestCoverDeriveRefreshReplacesOnlyEntriesItWrote(t *testing.T) {
	root := t.TempDir()
	p := paths{Verification: root, EvidenceRoot: filepath.Join(root, "evidence")}
	writeTestJSON(t, filepath.Join(root, "scenarios", "A.json"), map[string]any{
		"id": "A", "feature": "F-A",
		"steps": []map[string]any{
			{"verb": "click", "name": "按钮 A"},
			{"verb": "waitText", "text": "A 的结果"},
		},
	})
	writeTestJSON(t, filepath.Join(root, "evidence", "run", "F-A", "result.json"), map[string]any{
		"ok": true, "lane": "window",
		"steps": []map[string]any{
			{"index": 1, "verb": "click", "ok": true},
			{"index": 2, "verb": "waitText", "ok": true},
		},
	})
	writeTestJSON(t, filepath.Join(root, "controls", "inventory.json"), controls.Inventory{
		Schema: 1,
		Controls: []controls.Control{
			{Name: "按钮 A", Role: "button", Page: "page", Feature: "F-A"},
			{Name: "按钮 B", Role: "button", Page: "page", Feature: "F-B"},
		},
	})
	manual := controls.Witness{Name: "按钮 B", Role: "button", Page: "page", Action: "click", Journey: "gone", Note: "hand-written; must survive refresh"}
	stale := controls.Witness{Name: "按钮 A", Role: "button", Page: "page", Action: "click", Journey: "controls-old",
		Note: "derived from a green journey; kept by cover derive"}
	writeTestJSON(t, filepath.Join(root, "controls", "ledger.json"), controls.Ledger{Schema: 1, Witnesses: []controls.Witness{manual, stale}})

	if code := coverDerive(p, parseFlags([]string{"--refresh"})); code != 0 {
		t.Fatalf("cover derive --refresh exited %d", code)
	}
	raw, err := os.ReadFile(filepath.Join(root, "controls", "ledger.json"))
	if err != nil {
		t.Fatal(err)
	}
	var ledger controls.Ledger
	if err := json.Unmarshal(raw, &ledger); err != nil {
		t.Fatal(err)
	}
	byName := map[string]controls.Witness{}
	for _, witness := range ledger.Witnesses {
		if _, exists := byName[witness.Name]; exists {
			t.Fatalf("duplicate witness for %q: %+v", witness.Name, ledger.Witnesses)
		}
		byName[witness.Name] = witness
	}
	if byName["按钮 A"].Journey != "A" || byName["按钮 A"].Step != 1 {
		t.Fatalf("the derived entry was not refreshed: %+v", byName["按钮 A"])
	}
	if byName["按钮 B"].Journey != "gone" || byName["按钮 B"].Note != manual.Note {
		t.Fatalf("a human witness was overwritten or dropped: %+v", byName["按钮 B"])
	}
}
