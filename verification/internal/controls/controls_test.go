package controls

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- fixtures -------------------------------------------------------------

func writeJSON(t *testing.T, path string, value any) {
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

// fixture lays out a scenario dir and an evidence root with one green journey.
type fixture struct {
	scenarios string
	evidence  string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	root := t.TempDir()
	f := fixture{scenarios: filepath.Join(root, "scenarios"), evidence: filepath.Join(root, "evidence")}
	writeJSON(t, filepath.Join(f.scenarios, "F-02-nav.json"), Scenario{
		ID: "F-02-nav", Feature: "F-02",
		Steps: []Step{
			{Verb: "waitText", Text: "白板标题"},
			{Verb: "click", Name: "洞察"},
			{Verb: "waitText", Text: "洞察概览窗口"},
		},
	})
	writeJSON(t, filepath.Join(f.scenarios, "F-05-composer.json"), Scenario{
		ID: "F-05-composer", Feature: "F-05",
		Steps: []Step{
			{Verb: "type", Name: "消息", Text: "验证用文本"},
			{Verb: "assertAccess", Name: "消息", Value: "验证用文本"},
		},
	})
	writeJSON(t, filepath.Join(f.scenarios, "F-15-tray.json"), Scenario{
		ID: "F-15-tray", Feature: "F-15",
		Steps: []Step{
			{Verb: "open"},
			{Verb: "click", Name: "打开 Graph"},
			{Verb: "assertText", Text: "主区域卡片"},
		},
	})
	writeEvidence(t, f, "run-green", "F-02", "window", true, []evidenceStep{
		{Index: 1, Verb: "waitText", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "waitText", OK: true},
	})
	writeEvidence(t, f, "run-green", "F-05", "headless", true, []evidenceStep{
		{Index: 1, Verb: "type", OK: true},
		{Index: 2, Verb: "assertAccess", OK: true},
	})
	writeEvidence(t, f, "run-green", "F-15", "surface", true, []evidenceStep{
		{Index: 1, Verb: "open", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "assertText", OK: true},
	})
	writeEvidence(t, f, "run-red", "F-02", "headless", false, []evidenceStep{
		{Index: 1, Verb: "waitText", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "waitText", OK: false},
	})
	return f
}

func writeEvidence(t *testing.T, f fixture, run, feature, lane string, ok bool, steps []evidenceStep) {
	t.Helper()
	dir := filepath.Join(f.evidence, run, feature)
	writeJSON(t, filepath.Join(dir, "result.json"), evidenceResult{OK: ok, Lane: lane, Steps: steps})
	writeJSON(t, filepath.Join(dir, "summary.json"), evidenceSummary{OK: ok, Lane: lane, Run: run, Feature: feature})
}

func button(name, page, feature string) Control {
	return Control{Name: name, Role: "button", Page: page, Feature: feature}
}

// --- manifest stability ---------------------------------------------------

func TestNormalizeIsStableUnderInputOrderAndBoundsJitter(t *testing.T) {
	x := Bounds{X: 10, Y: 20, Width: 30, Height: 40}
	y := Bounds{X: 11, Y: 22, Width: 30, Height: 40}
	first := Inventory{Controls: []Control{
		{Name: "洞察", Role: "Button", Page: "rail", Bounds: &x},
		{Name: "设置", Role: "button", Page: "rail"},
		{Name: "洞察", Role: "button", Page: "rail"}, // duplicate
	}}
	second := Inventory{Controls: []Control{
		{Name: "设置", Role: "button", Page: "rail"},
		{Name: "洞察", Role: "button", Page: "rail", Bounds: &y},
	}}
	a, b := Normalize(first), Normalize(second)
	if len(a.Controls) != 2 {
		t.Fatalf("duplicate control was not collapsed: %+v", a.Controls)
	}
	if len(a.Controls) != len(b.Controls) {
		t.Fatalf("different counts: %d vs %d", len(a.Controls), len(b.Controls))
	}
	for index := range a.Controls {
		if a.Controls[index].Key() != b.Controls[index].Key() {
			t.Fatalf("order changed: %s vs %s", a.Controls[index].Key(), b.Controls[index].Key())
		}
		if a.Controls[index].ID() != b.Controls[index].ID() {
			t.Fatalf("id changed when only bounds moved: %s vs %s", a.Controls[index].ID(), b.Controls[index].ID())
		}
	}
	if a.Controls[0].ID() == a.Controls[1].ID() {
		t.Fatal("two different controls share an id")
	}
}

func TestNormalizeDropsControlsWithoutIdentity(t *testing.T) {
	inventory := Normalize(Inventory{Controls: []Control{
		{Name: "", Role: "button", Page: "rail"},
		{Name: "洞察", Role: "", Page: "rail"},
		{Name: "洞察", Role: "button", Page: ""},
		{Name: "洞察", Role: "button", Page: "rail"},
	}})
	if len(inventory.Controls) != 1 {
		t.Fatalf("a control needs name, role and page; got %+v", inventory.Controls)
	}
}

// --- classification -------------------------------------------------------

func runAudit(t *testing.T, f fixture, controls []Control, ledger Ledger) Report {
	t.Helper()
	inventoryPath := filepath.Join(t.TempDir(), "inventory.json")
	if err := WriteInventory(inventoryPath, Inventory{Controls: controls}); err != nil {
		t.Fatal(err)
	}
	inventory, err := ReadInventory(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	return Audit(inventoryPath, "ledger.json", f.scenarios, f.evidence, inventory, ledger)
}

func TestAClaimedWitnessMustProveItselfGreen(t *testing.T) {
	f := newFixture(t)
	report := runAudit(t, f,
		[]Control{button("洞察", "rail", "F-02")},
		Ledger{Witnesses: []Witness{{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"}}})
	if !report.OK() || report.Covered != 1 || report.Total != 1 {
		t.Fatalf("a green journey step must cover the control: %+v", report)
	}
	conclusion := report.Conclusions[0]
	if conclusion.Status != "covered" || conclusion.Step != 2 || conclusion.Lane != "window" {
		t.Fatalf("conclusion = %+v", conclusion)
	}
	if !strings.Contains(conclusion.Evidence, "run-green/F-02") {
		t.Fatalf("evidence path = %q", conclusion.Evidence)
	}
}

func TestAClickWithoutAVisibleResultIsNotAClaim(t *testing.T) {
	f := newFixture(t)
	// Point at a journey whose only later assertion waits for the control
	// itself: that text was already there, so it cannot witness the click.
	writeJSON(t, filepath.Join(f.scenarios, "F-99-vanity.json"), Scenario{
		ID: "F-99-vanity", Feature: "F-99",
		Steps: []Step{{Verb: "click", Name: "洞察"}, {Verb: "waitText", Text: "洞察"}},
	})
	writeEvidence(t, f, "run-vanity", "F-99", "window", true, []evidenceStep{
		{Index: 1, Verb: "click", OK: true},
		{Index: 2, Verb: "waitText", OK: true},
	})
	report := runAudit(t, f,
		[]Control{{Name: "洞察", Role: "button", Page: "rail", Feature: "F-99"}},
		Ledger{Witnesses: []Witness{{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-99-vanity"}}})
	if report.OK() {
		t.Fatal("waiting for the clicked text itself is not evidence of a state change")
	}
	if report.Conclusions[0].Status != "blocked" || !hasProblem(report, "witness-unproven") {
		t.Fatalf("report = %+v", report)
	}
}

func TestTypedTextMustBeReadBackFromTheControl(t *testing.T) {
	f := newFixture(t)
	report := runAudit(t, f,
		[]Control{{Name: "消息", Role: "textfield", Page: "composer", Feature: "F-05"}},
		Ledger{Witnesses: []Witness{{Name: "消息", Role: "textfield", Page: "composer", Action: "type", Journey: "F-05-composer"}}})
	if !report.OK() || report.Conclusions[0].Status != "covered" {
		t.Fatalf("typing plus assertAccess value must cover: %+v", report)
	}
}

func TestAMenuItemCannotBeProvenInHeadless(t *testing.T) {
	f := newFixture(t)
	// Rewrite the tray evidence as if it came from headless: a surface item
	// must never pass on a lane that cannot see the menu bar.
	writeEvidence(t, f, "run-headless-tray", "F-15", "headless", true, []evidenceStep{
		{Index: 1, Verb: "open", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "assertText", OK: true},
	})
	report := runAudit(t, f,
		[]Control{{Name: "打开 Graph", Role: "menuitem", Page: "tray", Feature: "F-15"}},
		Ledger{Witnesses: []Witness{{Name: "打开 Graph", Role: "menuitem", Page: "tray", Action: "open", Journey: "F-15-tray", Evidence: []string{"run-headless-tray"}}}})
	if report.OK() || report.Conclusions[0].Status != "blocked" {
		t.Fatalf("a tray item must not pass on the headless lane: %+v", report)
	}
	if !strings.Contains(report.Conclusions[0].Reason, "must be proven in") {
		t.Fatalf("reason = %q", report.Conclusions[0].Reason)
	}
}

func TestAnUnownedControlIsARedUnknown(t *testing.T) {
	f := newFixture(t)
	report := runAudit(t, f, []Control{button("洞察", "rail", "F-02")}, Ledger{})
	if report.OK() {
		t.Fatal("a control with no conclusion must make the audit red")
	}
	if report.Conclusions[0].Status != "unknown" || !hasProblem(report, "unowned-control") {
		t.Fatalf("report = %+v", report)
	}
}

func TestNotApplicableNeedsAConcreteReason(t *testing.T) {
	f := newFixture(t)
	controls := []Control{button("洞察", "rail", "F-02")}
	ok := runAudit(t, f, controls, Ledger{NotApplicable: []Exclusion{{Name: "洞察", Role: "button", Page: "rail", Reason: "one-off dialog; no stable entry"}}})
	if !ok.OK() || ok.NotApplicable != 1 {
		t.Fatalf("a reasoned exclusion is a valid conclusion: %+v", ok)
	}
	bad := runAudit(t, f, controls, Ledger{NotApplicable: []Exclusion{{Name: "洞察", Role: "button", Page: "rail"}}})
	if bad.OK() || !hasProblem(bad, "exclusion-without-reason") {
		t.Fatalf("a reasonless exclusion must be red: %+v", bad)
	}
}

func TestBlockedNeedsReasonAndNext(t *testing.T) {
	f := newFixture(t)
	controls := []Control{button("退出 Graph", "tray", "F-15")}
	good := runAudit(t, f, controls, Ledger{Blocked: []Exclusion{{Name: "退出 Graph", Role: "button", Page: "tray",
		Reason: "pressing it stops the instance the remaining steps need", Attempts: []string{"F-15 asserts the item exists"},
		Next: "add a terminal journey that presses it and asserts the process is gone"}}})
	if !good.OK() || good.Blocked != 1 {
		t.Fatalf("a complete blocked entry is honest: %+v", good)
	}
	bad := runAudit(t, f, controls, Ledger{Blocked: []Exclusion{{Name: "退出 Graph", Role: "button", Page: "tray", Reason: "unknown"}}})
	if bad.OK() || !hasProblem(bad, "blocked-incomplete") {
		t.Fatalf("blocked without a next step must be red: %+v", bad)
	}
}

func TestOneControlCannotHaveTwoConclusions(t *testing.T) {
	f := newFixture(t)
	report := runAudit(t, f, []Control{button("洞察", "rail", "F-02")}, Ledger{
		Witnesses:     []Witness{{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"}},
		NotApplicable: []Exclusion{{Name: "洞察", Role: "button", Page: "rail", Reason: "conflicting claim"}},
	})
	if report.OK() || !hasProblem(report, "duplicate-conclusion") {
		t.Fatalf("report = %+v", report)
	}
}

func TestTheLedgerCannotPromiseControlsTheInventoryDoesNotHave(t *testing.T) {
	f := newFixture(t)
	report := runAudit(t, f, []Control{button("洞察", "rail", "F-02")}, Ledger{
		Witnesses: []Witness{
			{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"},
			{Name: "已删除的按钮", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"},
		},
	})
	if report.OK() || !hasProblem(report, "stale-witness") {
		t.Fatalf("a witness for a control that no longer exists is a lie: %+v", report)
	}
}

func TestRedEvidenceCannotCoverAnything(t *testing.T) {
	f := newFixture(t)
	writeJSON(t, filepath.Join(f.scenarios, "F-98-red.json"), Scenario{
		ID: "F-98-red", Feature: "F-98",
		Steps: []Step{{Verb: "click", Name: "洞察"}, {Verb: "waitText", Text: "洞察概览窗口"}},
	})
	writeEvidence(t, f, "run-red-98", "F-98", "window", false, []evidenceStep{
		{Index: 1, Verb: "click", OK: true},
		{Index: 2, Verb: "waitText", OK: false},
	})
	report := runAudit(t, f,
		[]Control{{Name: "洞察", Role: "button", Page: "rail", Feature: "F-98"}},
		Ledger{Witnesses: []Witness{{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-98-red", Evidence: []string{"run-red-98"}}}})
	if report.OK() || report.Conclusions[0].Status != "blocked" {
		t.Fatalf("a red run must not cover a control: %+v", report)
	}
}

func TestTheReportCountsAndRendersEveryConclusion(t *testing.T) {
	f := newFixture(t)
	report := runAudit(t, f, []Control{
		button("洞察", "rail", "F-02"),
		button("退出 Graph", "tray", "F-15"),
		button("一次性按钮", "dialog", "F-99"),
	}, Ledger{
		Witnesses:     []Witness{{Name: "洞察", Role: "button", Page: "rail", Action: "click", Journey: "F-02-nav"}},
		Blocked:       []Exclusion{{Name: "退出 Graph", Role: "button", Page: "tray", Reason: "stops the instance", Next: "terminal journey"}},
		NotApplicable: []Exclusion{{Name: "一次性按钮", Role: "button", Page: "dialog", Reason: "one-off dialog"}},
	})
	if !report.OK() {
		t.Fatalf("report = %+v", report)
	}
	if report.Total != 3 || report.Covered != 1 || report.Blocked != 1 || report.NotApplicable != 1 || report.Journeys != 1 {
		t.Fatalf("counts = %+v", report)
	}
	path, markdown, err := WriteAudit(t.TempDir(), report)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var reread Report
	if err := json.Unmarshal(raw, &reread); err != nil {
		t.Fatal(err)
	}
	if reread.Covered != 1 || len(reread.Conclusions) != 3 {
		t.Fatalf("coverage.json = %+v", reread)
	}
	body, err := os.ReadFile(markdown)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"1/3 covered", "| rail | button | 洞察 | covered |", "退出 Graph | blocked", "一次性按钮 | not-applicable"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("generated markdown misses %q:\n%s", want, body)
		}
	}
}

func hasProblem(report Report, code string) bool {
	for _, problem := range report.Problems {
		if problem.Code == code {
			return true
		}
	}
	return false
}

func TestDeriveKeepsOnlyJourneysThatReallyProveTheControl(t *testing.T) {
	f := newFixture(t)
	inventory := Normalize(Inventory{Controls: []Control{
		button("洞察", "rail", "F-02"),
		button("设置", "rail", "F-02"), // no journey clicks it
		{Name: "消息", Role: "textfield", Page: "composer", Feature: "F-05"},
	}})
	witnesses, unresolved, problems := Derive(inventory, f.scenarios, f.evidence)
	if len(witnesses) != 2 {
		t.Fatalf("witnesses = %+v; unresolved = %v", witnesses, unresolved)
	}
	if len(unresolved) != 1 || !strings.Contains(unresolved[0], "设置") {
		t.Fatalf("settings must stay unresolved: %v", unresolved)
	}
	if len(problems) == 0 || problems[0].Code != "controls-unresolved" {
		t.Fatalf("unresolved controls must be reported: %+v", problems)
	}
	byName := map[string]Witness{}
	for _, witness := range witnesses {
		byName[witness.Name] = witness
	}
	if byName["洞察"].Action != "click" || byName["洞察"].Journey != "F-02-nav" || byName["洞察"].Step != 2 {
		t.Fatalf("derived click witness = %+v", byName["洞察"])
	}
	if byName["消息"].Action != "type" || byName["消息"].Step != 1 {
		t.Fatalf("derived type witness = %+v", byName["消息"])
	}
	if lanes := byName["洞察"].Lanes; len(lanes) != 1 || lanes[0] != "window" {
		t.Fatalf("derived witness must keep the lane that proved it: %+v", byName["洞察"])
	}
}

func TestDeriveRefusesARedJourney(t *testing.T) {
	f := newFixture(t)
	// Use a control no green journey drives: the fixture's F-02-nav also
	// clicks 洞察, and a green witness from another journey is legitimate.
	writeJSON(t, filepath.Join(f.scenarios, "F-97-red.json"), Scenario{
		ID: "F-97-red", Feature: "F-97",
		Steps: []Step{{Verb: "click", Name: "红色按钮"}, {Verb: "waitText", Text: "红色结果"}},
	})
	writeEvidence(t, f, "run-red-97", "F-97", "window", false, []evidenceStep{
		{Index: 1, Verb: "click", OK: true},
		{Index: 2, Verb: "waitText", OK: false},
	})
	inventory := Normalize(Inventory{Controls: []Control{{Name: "红色按钮", Role: "button", Page: "rail", Feature: "F-97"}}})
	witnesses, unresolved, _ := Derive(inventory, f.scenarios, f.evidence)
	if len(witnesses) != 0 || len(unresolved) != 1 {
		t.Fatalf("a red run must not become a witness: %+v %v", witnesses, unresolved)
	}
}

func TestAWindowOnlyWitnessSkipsTheHeadlessRunThatSortedFirst(t *testing.T) {
	f := newFixture(t)
	// "run-a-headless" sorts before "run-b-window": before the lane filter,
	// the audit stopped at the first run that passed the step and declared
	// the menu item unprovable even though a window run had proved it.
	writeEvidence(t, f, "run-a-headless", "F-15", "headless", true, []evidenceStep{
		{Index: 1, Verb: "open", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "assertText", OK: true},
	})
	writeEvidence(t, f, "run-b-window", "F-15", "window", true, []evidenceStep{
		{Index: 1, Verb: "open", OK: true},
		{Index: 2, Verb: "click", OK: true},
		{Index: 3, Verb: "assertText", OK: true},
	})
	report := runAudit(t, f,
		[]Control{{Name: "打开 Graph", Role: "menuitem", Page: "tray", Feature: "F-15"}},
		Ledger{Witnesses: []Witness{{Name: "打开 Graph", Role: "menuitem", Page: "tray", Action: "click", Journey: "F-15-tray"}}})
	if !report.OK() || report.Conclusions[0].Status != "covered" {
		t.Fatalf("the window run must be found after the headless one is rejected: %+v", report)
	}
	if !strings.Contains(report.Conclusions[0].Evidence, "run-b-window") {
		t.Fatalf("evidence = %q; it must be the window run", report.Conclusions[0].Evidence)
	}
}

func TestACanonicalShellControlFindsEvidenceUnderTheJourneyFeature(t *testing.T) {
	f := newFixture(t)
	writeJSON(t, filepath.Join(f.scenarios, "controls-shell.json"), Scenario{
		ID: "controls-shell", Feature: "controls-shell",
		Steps: []Step{
			{Verb: "click", Name: "main agent 会话"},
			{Verb: "waitText", Text: "消息"},
		},
	})
	writeEvidence(t, f, "run-shell", "controls-shell", "headless", true, []evidenceStep{
		{Index: 1, Verb: "click", OK: true},
		{Index: 2, Verb: "waitText", OK: true},
	})
	control := button("main agent 会话", "shell", "F-07")
	report := runAudit(t, f, []Control{control},
		Ledger{Witnesses: []Witness{{Name: control.Name, Role: control.Role, Page: control.Page,
			Action: "click", Journey: "controls-shell"}}})
	if !report.OK() || report.Conclusions[0].Status != "covered" {
		t.Fatalf("a control in the shell is proven by the journey that clicked it, not only by the page it was captured on: %+v", report)
	}
}
