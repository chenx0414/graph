package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"graph/verification/internal/controls"
)

// cover is the control-level half of verify-graph. A journey proves that a
// feature works; cover proves that every interactive control in the stable UI
// was actually driven, or says in one honest sentence why it was not.
//
//	verify-graph cover inventory --run <run>     # build controls/inventory.json from AX dumps
//	verify-graph cover derive                    # turn green journey steps into witnesses
//	verify-graph cover audit                     # re-check every claim against journeys + evidence
//
// The audit is intentionally offline and re-runnable: it reads the journey
// files and the recorded runs, so a hand-written "covered" label cannot pass.
func coverCommand(p paths, args []string) int {
	flags := parseFlags(args)
	verb := "audit"
	if len(flags.rest) > 0 {
		verb = flags.rest[0]
	}
	switch verb {
	case "audit":
		return coverAudit(p, flags)
	case "inventory":
		return coverInventory(p, flags)
	case "derive":
		return coverDerive(p, flags)
	default:
		return failEnvelope("cover", "", codeUsage, "unknown cover verb "+verb,
			"use: verify-graph cover audit | verify-graph cover inventory --run <run> | verify-graph cover derive").print()
	}
}

func coverPaths(p paths, flags flags) (inventory, ledger string) {
	root := filepath.Join(p.Verification, "controls")
	inventory = flags.value("inventory", filepath.Join(root, "inventory.json"))
	ledger = flags.value("ledger", filepath.Join(root, "ledger.json"))
	return inventory, ledger
}

func coverAudit(p paths, flags flags) int {
	inventoryPath, ledgerPath := coverPaths(p, flags)
	outDir := flags.value("out", filepath.Join(p.Verification, "controls"))
	inventory, err := controls.ReadInventory(inventoryPath)
	if err != nil {
		return failEnvelope("cover.audit", "", codeControlsInventory, "cannot read the control inventory: "+err.Error(),
			"build it first: verify-graph cover inventory --run <run>  (or pass --inventory <path>)").print()
	}
	ledger, err := controls.ReadLedger(ledgerPath)
	if err != nil {
		return failEnvelope("cover.audit", "", codeControlsLedger, "cannot read the witness ledger: "+err.Error(),
			"write "+ledgerPath+" with witnesses/notApplicable/blocked entries, or pass --ledger <path>").print()
	}
	report := controls.Audit(inventoryPath, ledgerPath, scenarioDir(p), p.EvidenceRoot, inventory, ledger)
	warnings := []string{}
	// A witness re-read from the journey and the recorded run still passes when
	// the page it drives has since been rebuilt or deleted: same button name,
	// older run. Judge that separately, and say plainly which pages cannot be
	// judged at all instead of guessing their sources from control names.
	appDir := filepath.Join(p.Verification, "..", "app")
	_, mapErr := os.Stat(filepath.Join(p.Verification, pageMapPath))
	switch {
	case mapErr == nil:
		for _, problem := range checkDeclaredSources(p.Verification, appDir) {
			report.Problems = append(report.Problems, controls.Problem{Code: "undeclared-source", Detail: problem})
		}
		for _, problem := range undeclaredPages(p.Verification, ledgerPath) {
			report.Problems = append(report.Problems, controls.Problem{Code: "undeclared-page", Detail: problem})
		}
		for _, problem := range staleWitnessPages(p.Verification, ledgerPath, appDir) {
			report.Problems = append(report.Problems, controls.Problem{Code: "stale-evidence", Detail: problem})
		}
	case os.IsNotExist(mapErr):
		// A tree without the page map keeps the older, narrower audit. Saying so
		// out loud is the difference between "not applicable here" and "checked".
		warnings = append(warnings, "no "+pageMapPath+" in this tree: witness evidence is not judged against page changes")
	}
	jsonPath, markdownPath, err := controls.WriteAudit(outDir, report)
	if err != nil {
		return failEnvelope("cover.audit", "", codeUsage, "cannot write the coverage report: "+err.Error(),
			"check permissions on "+outDir).print()
	}
	data := map[string]any{
		"total": report.Total, "covered": report.Covered, "notApplicable": report.NotApplicable,
		"blocked": report.Blocked, "journeys": report.Journeys, "lanes": report.Lanes,
		"problems": report.Problems, "conclusions": report.Conclusions,
		"inventory": inventoryPath, "ledger": ledgerPath,
		"coverage": jsonPath, "markdown": markdownPath,
	}
	result := okEnvelope("cover.audit", "", data)
	result.add(fileArtifact("json", jsonPath, "audited control coverage"))
	result.add(fileArtifact("markdown", markdownPath, "generated control coverage summary"))
	if len(report.Problems) > 0 {
		result.OK = false
		result.Error = &cliError{Code: codeControlsGap,
			Message: fmt.Sprintf("%d control-coverage problem(s); %d/%d covered, %d not-applicable, %d blocked",
				len(report.Problems), report.Covered, report.Total, report.NotApplicable, report.Blocked),
			Hint: controlsHint(report)}
		return result.print()
	}
	if flags.has("require-all-covered") && report.Covered < report.Total {
		result.OK = false
		result.Error = &cliError{Code: codeControlsGap,
			Message: fmt.Sprintf("only %d/%d controls are covered", report.Covered, report.Total),
			Hint:    "drive the blocked controls in a journey, or record why they cannot be reached"}
		return result.print()
	}
	for _, warning := range warnings {
		result.warn("%s", warning)
	}
	if report.Blocked > 0 {
		result.warn("%d control(s) are blocked; see %s", report.Blocked, markdownPath)
	}
	return result.print()
}

func controlsHint(report controls.Report) string {
	for _, problem := range report.Problems {
		switch problem.Code {
		case "unowned-control":
			return "the first unowned control needs a witness or an exclusion; see " + problem.Control + " in controls/COVERAGE.generated.md"
		case "witness-unproven":
			return "a claimed witness does not prove itself; read its problem detail, then rerun the journey it names"
		case "duplicate-conclusion", "exclusion-without-reason", "blocked-incomplete":
			return "fix the ledger entry; each control has exactly one conclusion with a reason"
		case "stale-witness", "stale-exclusion":
			return "the ledger promises controls the inventory does not have; refresh the inventory, then delete the stale entry"
		case "stale-evidence":
			return "a witness is older than the page it describes; rerun the journey that covers that page, then cover audit again"
		case "undeclared-page":
			return "declare the page's sources in controls/pages.json, or the audit cannot tell whether its evidence is stale"
		case "undeclared-source":
			return "a page declares a source file that no longer exists; fix " + pageMapPath
		}
	}
	return "read controls/COVERAGE.generated.md, then rerun verify-graph cover audit"
}

func coverInventory(p paths, flags flags) int {
	inventoryPath, _ := coverPaths(p, flags)
	var inventory controls.Inventory
	if !flags.has("replace") {
		if existing, err := controls.ReadInventory(inventoryPath); err == nil {
			inventory = existing
		}
	}
	sources := []string{}
	if axes := flags.all("ax"); len(axes) > 0 {
		page := flags.value("page", "")
		feature := flags.value("feature", "")
		if page == "" {
			return failEnvelope("cover.inventory", "", codeUsage, "--page is required with --ax",
				"name the stable page the snapshot belongs to, e.g. --page rail").print()
		}
		for _, path := range axes {
			added, err := addAXFile(&inventory, path, page, feature)
			if err != nil {
				return failEnvelope("cover.inventory", "", codeUsage, "cannot read AX snapshot: "+err.Error(),
					"pass a snapshot written by: verify-graph ui text --run <run> (it has nodes[] with name/role)").print()
			}
			sources = append(sources, fmt.Sprintf("%s (%d controls)", path, added))
		}
	} else {
		runs := flags.all("run")
		added, used, err := addEvidenceRuns(&inventory, p.EvidenceRoot, runs)
		if err != nil {
			return failEnvelope("cover.inventory", "", codeUsage, "cannot read recorded AX evidence: "+err.Error(),
				"run the window lane first: verify-graph verify --all --lane window").print()
		}
		sources = used
		inventory.GeneratedAt = ""
		_ = added
	}
	if len(inventory.Controls) == 0 {
		return failEnvelope("cover.inventory", "", codeControlsInventory, "no interactive controls were found",
			"point at a window-lane run: verify-graph cover inventory --run <run> (headless frames carry no AX roles)").print()
	}
	inventory.App = firstNonEmpty(inventory.App, "Graph")
	if err := controls.WriteInventory(inventoryPath, inventory); err != nil {
		return failEnvelope("cover.inventory", "", codeUsage, "cannot write "+inventoryPath+": "+err.Error(),
			"check permissions on verification/controls").print()
	}
	result := okEnvelope("cover.inventory", "", map[string]any{
		"inventory": inventoryPath, "controls": len(inventory.Controls), "sources": sources,
	})
	result.add(fileArtifact("json", inventoryPath, "control inventory"))
	return result.print()
}

// addEvidenceRuns builds manifest rows from the AX dumps the window lane
// already wrote (result.json access[]). A headless frame has no roles, so it
// cannot contribute: the inventory must come from the real accessibility tree.
func addEvidenceRuns(inventory *controls.Inventory, evidenceRoot string, runs []string) (int, []string, error) {
	entries, err := os.ReadDir(evidenceRoot)
	if err != nil {
		return 0, nil, err
	}
	wanted := map[string]bool{}
	for _, run := range runs {
		wanted[run] = true
	}
	used := []string{}
	total := 0
	runNames := []string{}
	for _, entry := range entries {
		if entry.IsDir() && (len(wanted) == 0 || wanted[entry.Name()]) {
			runNames = append(runNames, entry.Name())
		}
	}
	sort.Strings(runNames)
	for _, run := range runNames {
		features, err := os.ReadDir(filepath.Join(evidenceRoot, run))
		if err != nil {
			continue
		}
		for _, featureEntry := range features {
			if !featureEntry.IsDir() {
				continue
			}
			dir := filepath.Join(evidenceRoot, run, featureEntry.Name())
			added, lane, ok := addEvidenceDir(inventory, dir, featureEntry.Name(), run)
			if !ok {
				continue
			}
			used = append(used, fmt.Sprintf("%s/%s (%s, %d controls)", run, featureEntry.Name(), lane, added))
			total += added
		}
	}
	return total, used, nil
}

func addEvidenceDir(inventory *controls.Inventory, dir, feature, run string) (int, string, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "result.json"))
	if err != nil {
		return 0, "", false
	}
	var result struct {
		OK     bool   `json:"ok"`
		Lane   string `json:"lane"`
		Access []struct {
			Name   string           `json:"name"`
			Role   string           `json:"role"`
			Value  string           `json:"value"`
			Bounds *controls.Bounds `json:"bounds"`
		} `json:"access"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return 0, "", false
	}
	if !result.OK || len(result.Access) == 0 {
		return 0, "", false
	}
	lane := firstNonEmpty(result.Lane, "headless")
	if lane == "headless" {
		return 0, "", false
	}
	rows := []controls.Control{}
	for _, node := range result.Access {
		if !controls.IsInteractiveRole(node.Role) || strings.TrimSpace(node.Name) == "" {
			continue
		}
		requires := ""
		if controls.IsMenuRole(node.Role) {
			requires = "window"
		}
		rows = append(rows, controls.Control{
			Name: node.Name, Role: node.Role, Page: stablePage(node.Name, node.Role, feature), Feature: feature,
			Bounds: node.Bounds, Requires: requires,
		})
	}
	if len(rows) == 0 {
		return 0, "", false
	}
	controls.AddControls(inventory, rows, controls.Source{
		Lane: lane, Run: run, Feature: feature, Page: feature, Evidence: dir, Controls: len(rows),
	})
	return len(rows), lane, true
}

// addAXFile merges one accessibility snapshot. It accepts the shape written by
// `verify-graph ui text` ({nodes:[{name,role,bounds}]}), a plain array, or a
// nested tree ({tree:{role,name,children}}), so a tour can feed either form.
func addAXFile(inventory *controls.Inventory, path, page, feature string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	var document struct {
		Nodes []axNode `json:"nodes"`
		Tree  *axNode  `json:"tree"`
		Items []axNode `json:"items"`
	}
	rows := []controls.Control{}
	appendNode := func(node axNode) {
		name := firstNonEmpty(node.Name, node.Label)
		role := roleName(node.Role)
		if name == "" || !controls.IsInteractiveRole(role) {
			return
		}
		requires := ""
		if controls.IsMenuRole(role) {
			requires = "window"
		}
		rows = append(rows, controls.Control{Name: name, Role: role, Page: page, Feature: feature, Bounds: node.Bounds, Requires: requires})
	}
	if err := json.Unmarshal(raw, &document); err == nil && (len(document.Nodes) > 0 || document.Tree != nil || len(document.Items) > 0) {
		for _, node := range document.Nodes {
			appendNode(node)
		}
		for _, node := range document.Items {
			appendNode(node)
		}
		if document.Tree != nil {
			walkAX(*document.Tree, appendNode)
		}
	} else {
		var array []axNode
		if err := json.Unmarshal(raw, &array); err != nil {
			return 0, err
		}
		for _, node := range array {
			walkAX(node, appendNode)
		}
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("%s has no named interactive nodes", path)
	}
	added := controls.AddControls(inventory, rows, controls.Source{
		Lane: "window", Page: page, Feature: feature, Evidence: path, Controls: len(rows),
	})
	return added, nil
}

type axNode struct {
	Name     string           `json:"name"`
	Label    string           `json:"label"`
	Role     json.RawMessage  `json:"role"`
	Bounds   *controls.Bounds `json:"bounds"`
	Children []axNode         `json:"children"`
}

func walkAX(node axNode, visit func(axNode)) {
	visit(node)
	for _, child := range node.Children {
		walkAX(child, visit)
	}
}

func roleName(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.ToLower(strings.TrimSpace(text))
	}
	var object struct {
		Name string `json:"name"`
		Role string `json:"role"`
	}
	if err := json.Unmarshal(raw, &object); err == nil {
		return strings.ToLower(firstNonEmpty(object.Name, object.Role))
	}
	return ""
}

// stablePage names the stable location of a control instead of the journey that
// happened to observe it. The rail, the tab strip, the window chrome and the
// tray are one place each; everything else belongs to the page it was captured
// on. Without this, every journey that ends on the same shell would add another
// copy of the same rail button to the inventory.
func stablePage(name, role, feature string) string {
	switch {
	case role == "button" && railLabels[name]:
		return "rail"
	case strings.HasPrefix(name, "标签页 "):
		return "tabbar"
	case role == "button" && (name == "Close" || name == "Minimize" || name == "Full Screen" || name == "Zoom"):
		return "window"
	case controls.IsMenuRole(role):
		return "tray"
	case shellLabels[name]:
		return "shell"
	case composerLabels[name]:
		return "composer"
	case contextLabels[name]:
		return "context"
	case panelLabels[name]:
		return "panel"
	case boardLabels[name]:
		return "board"
	}
	return feature
}

var railLabels = map[string]bool{
	"轨迹": true, "洞察": true, "编队": true, "供应商": true, "资源": true, "装配": true, "设置": true,
}

// These labels appear on every page because they live in the shell, the
// composer, the context window or the panel chrome. The capture page must not
// turn one control into twenty copies.
var shellLabels = map[string]bool{"main agent 会话": true}

var composerLabels = map[string]bool{
	"消息": true, "发送": true, "附件": true, "模型": true, "暂停": true, "继续": true,
}

var contextLabels = map[string]bool{"上下文": true, "System Prompt": true, "工具声明": true}

var panelLabels = map[string]bool{"在新标签页打开": true, "移除": true}

var boardLabels = map[string]bool{"+": true, "−": true, "居中": true}

// coverDerive grows the ledger only with steps a green run already proved. It
// never overwrites a manual witness or an exclusion: a human decision wins.
func coverDerive(p paths, flags flags) int {
	inventoryPath, ledgerPath := coverPaths(p, flags)
	inventory, err := controls.ReadInventory(inventoryPath)
	if err != nil {
		return failEnvelope("cover.derive", "", codeControlsInventory, "cannot read the control inventory: "+err.Error(),
			"build it first: verify-graph cover inventory --run <run>").print()
	}
	ledger := controls.Ledger{Schema: 1}
	if existing, err := controls.ReadLedger(ledgerPath); err == nil {
		ledger = existing
	}
	witnesses, unresolved, _ := controls.Derive(inventory, scenarioDir(p), p.EvidenceRoot, ledger.EvidenceRuns)
	if flags.has("refresh") {
		// --refresh only drops entries derive itself wrote; a human witness or
		// an exclusion is never touched. This is how a renamed journey stops
		// leaving phantom witnesses behind.
		kept := make([]controls.Witness, 0, len(ledger.Witnesses))
		for _, witness := range ledger.Witnesses {
			if !strings.Contains(witness.Note, "derived from a green journey") {
				kept = append(kept, witness)
			}
		}
		ledger.Witnesses = kept
	}
	added, skipped := 0, 0
	for _, witness := range witnesses {
		if ledgerHasControl(ledger, witness.Name, witness.Role, witness.Page) {
			skipped++
			continue
		}
		ledger.Witnesses = append(ledger.Witnesses, witness)
		added++
	}
	if err := controls.WriteLedger(ledgerPath, ledger); err != nil {
		return failEnvelope("cover.derive", "", codeUsage, "cannot write "+ledgerPath+": "+err.Error(),
			"check permissions on verification/controls").print()
	}
	sample := unresolved
	if len(sample) > 40 {
		sample = sample[:40]
	}
	result := okEnvelope("cover.derive", "", map[string]any{
		"inventory": inventoryPath, "ledger": ledgerPath,
		"controls": len(inventory.Controls), "derived": added, "keptManual": skipped,
		"refreshed":  flags.has("refresh"),
		"unresolved": len(unresolved), "unresolvedSample": sample,
	})
	result.add(fileArtifact("json", ledgerPath, "witness ledger"))
	if len(unresolved) > 0 {
		result.warn("%d control(s) still have no green journey step", len(unresolved))
		result.next("drive the unresolved controls in a journey, then rerun: verify-graph cover derive")
	}
	result.next("re-check every claim: verify-graph cover audit")
	return result.print()
}

func ledgerHasControl(ledger controls.Ledger, name, role, page string) bool {
	match := func(entryName, entryRole, entryPage string) bool {
		if entryName != name {
			return false
		}
		if entryRole != "" && !strings.EqualFold(entryRole, role) {
			return false
		}
		if entryPage != "" && !strings.EqualFold(entryPage, page) {
			return false
		}
		return true
	}
	for _, witness := range ledger.Witnesses {
		if match(witness.Name, witness.Role, witness.Page) {
			return true
		}
	}
	for _, entry := range ledger.NotApplicable {
		if match(entry.Name, entry.Role, entry.Page) {
			return true
		}
	}
	for _, entry := range ledger.Blocked {
		if match(entry.Name, entry.Role, entry.Page) {
			return true
		}
	}
	return false
}
