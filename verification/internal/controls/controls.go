package controls

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Bounds is the control's location in window DIPs, as the accessibility tree
// reports it. It is evidence of "where", not an identity: moving a control
// must not change its id.
type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Control is one interactive element of the stable, user-reachable UI.
type Control struct {
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	Page     string  `json:"page"`
	Feature  string  `json:"feature,omitempty"`
	Bounds   *Bounds `json:"bounds,omitempty"`
	Stable   *bool   `json:"stable,omitempty"`
	Requires string  `json:"requires,omitempty"` // "window" when only the real window/menu can prove it
	Note     string  `json:"note,omitempty"`
}

// Key is the identity of a control: where it lives, what it is and what it is
// called. Bounds are excluded on purpose.
func (c Control) Key() string {
	return strings.ToLower(strings.TrimSpace(c.Page)) + "\x00" +
		strings.ToLower(strings.TrimSpace(c.Role)) + "\x00" +
		strings.TrimSpace(c.Name)
}

// ID is a stable, human-copyable handle for a control.
func (c Control) ID() string {
	sum := sha256.Sum256([]byte(c.Key()))
	return "ctl-" + hex.EncodeToString(sum[:])[:10]
}

// Source records which run and lane produced an inventory slice.
type Source struct {
	Lane     string `json:"lane,omitempty"`
	Run      string `json:"run,omitempty"`
	Feature  string `json:"feature,omitempty"`
	Page     string `json:"page,omitempty"`
	Evidence string `json:"evidence,omitempty"`
	Controls int    `json:"controls"`
}

// Inventory is the machine-readable control list. Any producer may write it;
// the audit only depends on this schema.
type Inventory struct {
	Schema      int       `json:"schema"`
	App         string    `json:"app,omitempty"`
	GeneratedAt string    `json:"generatedAt,omitempty"`
	Sources     []Source  `json:"sources,omitempty"`
	Controls    []Control `json:"controls"`
}

// Witness is one claim that a control was really driven: a journey action step,
// an assertion that observed a visible result afterwards, and the lane that
// must have proven it.
type Witness struct {
	Name     string   `json:"name"`
	Role     string   `json:"role,omitempty"`
	Page     string   `json:"page,omitempty"`
	Action   string   `json:"action"` // click | type | key | toggle | select | open
	Journey  string   `json:"journey"`
	Step     int      `json:"step,omitempty"`
	Expect   string   `json:"expect,omitempty"`
	Lanes    []string `json:"lanes,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
	Note     string   `json:"note,omitempty"`
}

// Exclusion is a control that is deliberately not covered. Reason is required
// for both kinds; blocked entries also need Next and should record Attempts.
type Exclusion struct {
	Name     string   `json:"name"`
	Role     string   `json:"role,omitempty"`
	Page     string   `json:"page,omitempty"`
	Reason   string   `json:"reason"`
	Attempts []string `json:"attempts,omitempty"`
	Next     string   `json:"next,omitempty"`
}

// Ledger is the hand-maintained side: witnesses and exclusions.
type Ledger struct {
	Schema int `json:"schema"`
	// EvidenceRuns names the runs this ledger's witnesses were proven by. The audit
	// reads only these, so an old run left on disk cannot decide whether a control
	// passes — and deleting one cannot turn the audit red.
	EvidenceRuns  []string    `json:"evidenceRuns,omitempty"`
	Witnesses     []Witness   `json:"witnesses,omitempty"`
	NotApplicable []Exclusion `json:"notApplicable,omitempty"`
	Blocked       []Exclusion `json:"blocked,omitempty"`
}

// Scenario is the subset of a journey file the audit reads.
type Scenario struct {
	ID      string `json:"id"`
	Feature string `json:"feature"`
	Lane    string `json:"lane,omitempty"`
	Steps   []Step `json:"steps"`
}

// Step is one journey step, as it appears in a scenario file.
type Step struct {
	Verb  string `json:"verb"`
	Name  string `json:"name,omitempty"`
	Role  string `json:"role,omitempty"`
	Text  string `json:"text,omitempty"`
	Value string `json:"value,omitempty"`
	Key   string `json:"key,omitempty"`
	Path  string `json:"path,omitempty"`
}

type evidenceStep struct {
	Index   int    `json:"index"`
	Verb    string `json:"verb"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped"`
}

type evidenceResult struct {
	OK     bool           `json:"ok"`
	Lane   string         `json:"lane,omitempty"`
	Steps  []evidenceStep `json:"steps"`
	Access []struct {
		Name  string `json:"name"`
		Role  string `json:"role"`
		Value string `json:"value"`
	} `json:"access"`
}

type evidenceSummary struct {
	OK      bool   `json:"ok"`
	Lane    string `json:"lane,omitempty"`
	Run     string `json:"run,omitempty"`
	Feature string `json:"feature,omitempty"`
}

// Conclusion is the single verdict for one control.
type Conclusion struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	Page     string  `json:"page"`
	Feature  string  `json:"feature,omitempty"`
	Status   string  `json:"status"` // covered | not-applicable | blocked
	Reason   string  `json:"reason,omitempty"`
	Action   string  `json:"action,omitempty"`
	Journey  string  `json:"journey,omitempty"`
	Step     int     `json:"step,omitempty"`
	Lane     string  `json:"lane,omitempty"`
	Evidence string  `json:"evidence,omitempty"`
	Next     string  `json:"next,omitempty"`
	Bounds   *Bounds `json:"bounds,omitempty"`
}

// Problem is a reason the audit is red.
type Problem struct {
	Code    string `json:"code"`
	Control string `json:"control,omitempty"`
	Detail  string `json:"detail"`
}

// Report is the audited coverage.
type Report struct {
	Inventory     string       `json:"inventory"`
	Ledger        string       `json:"ledger"`
	Total         int          `json:"total"`
	Covered       int          `json:"covered"`
	NotApplicable int          `json:"notApplicable"`
	Blocked       int          `json:"blocked"`
	Journeys      int          `json:"journeys"`
	Lanes         []string     `json:"lanes,omitempty"`
	Conclusions   []Conclusion `json:"conclusions"`
	Problems      []Problem    `json:"problems"`
}

// OK is true when every control has exactly one conclusion and every covered
// claim was proven. Blocked/not-applicable controls do not make it red: they
// are honest answers, and the report still counts them.
func (r Report) OK() bool { return len(r.Problems) == 0 }

// ReadInventory reads and normalizes an inventory file. A missing file is an
// error the caller can turn into an actionable hint.
func ReadInventory(path string) (Inventory, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Inventory{}, err
	}
	var inventory Inventory
	if err := json.Unmarshal(raw, &inventory); err != nil {
		return Inventory{}, fmt.Errorf("%s: %w", path, err)
	}
	if len(inventory.Controls) == 0 {
		return Inventory{}, fmt.Errorf("%s: an inventory needs at least one control", path)
	}
	inventory = Normalize(inventory)
	return inventory, nil
}

// WriteInventory writes the normalized, deterministic inventory.
func WriteInventory(path string, inventory Inventory) error {
	inventory = Normalize(inventory)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(inventory, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, markGenerated(raw), 0o644)
}

// generatedDirective tells the repository's file-budget gate why a generated
// coverage file is kept whole: it is one audit snapshot, regenerated from the
// inventory, ledger and evidence, not source that can be split.
const generatedDirective = "graph:allow-large-file: generated control-coverage data kept verbatim; regenerated by verify-graph, not source"

// markGenerated adds the directive without reordering the object a reader
// sees; it is inserted as the first key so generated diffs stay one line.
func markGenerated(raw []byte) []byte {
	text := string(raw)
	if strings.Contains(text, "\"_graph\"") {
		return append(raw, '\n')
	}
	index := strings.IndexByte(text, '{')
	if index < 0 {
		return append(raw, '\n')
	}
	return []byte(text[:index+1] + "\n  \"_graph\": \"" + generatedDirective + "\"," + text[index+1:] + "\n")
}

// ReadLedger reads the witness/exclusion ledger.
func ReadLedger(path string) (Ledger, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Ledger{}, err
	}
	var ledger Ledger
	if err := json.Unmarshal(raw, &ledger); err != nil {
		return Ledger{}, fmt.Errorf("%s: %w", path, err)
	}
	return ledger, nil
}

// Normalize dedupes controls by Key and returns a deterministic order, so the
// same UI always produces the same inventory no matter how the AX tree was
// walked. The first occurrence wins; later duplicates are dropped.
func Normalize(inventory Inventory) Inventory {
	if inventory.Schema == 0 {
		inventory.Schema = 1
	}
	seen := map[string]bool{}
	controls := make([]Control, 0, len(inventory.Controls))
	for _, control := range inventory.Controls {
		control.Name = strings.TrimSpace(control.Name)
		control.Role = strings.ToLower(strings.TrimSpace(control.Role))
		control.Page = strings.TrimSpace(control.Page)
		if control.Name == "" || control.Role == "" || control.Page == "" {
			continue
		}
		key := control.Key()
		if seen[key] {
			continue
		}
		seen[key] = true
		controls = append(controls, control)
	}
	sort.Slice(controls, func(i, j int) bool {
		if controls[i].Page != controls[j].Page {
			return controls[i].Page < controls[j].Page
		}
		if controls[i].Role != controls[j].Role {
			return controls[i].Role < controls[j].Role
		}
		return controls[i].Name < controls[j].Name
	})
	inventory.Controls = controls
	return inventory
}

// DefaultInteractiveRoles is the set of AX roles that can be driven. Static
// text, panes and groups are not controls; a row/list item is kept because a
// user selects it.
var DefaultInteractiveRoles = map[string]bool{
	"button": true, "togglebutton": true, "tab": true, "textfield": true,
	"textbox": true, "searchfield": true, "checkbox": true, "switch": true,
	"radio": true, "radiobutton": true, "menuitem": true, "menuitemcheckbox": true,
	"menuitemradio": true, "link": true, "combobox": true, "popupbutton": true,
	"slider": true, "row": true, "listitem": true, "treeitem": true,
	"disclosuretriangle": true, "incrementor": true, "colorwell": true,
}

// IsInteractiveRole reports whether a role is a control a user can operate.
func IsInteractiveRole(role string) bool {
	return DefaultInteractiveRoles[strings.ToLower(strings.TrimSpace(role))]
}

// AddControls merges controls into the inventory, deduping by Key and recording
// the source slice. It is how an AX dump becomes manifest rows.
func AddControls(inventory *Inventory, controls []Control, source Source) int {
	if inventory.Schema == 0 {
		inventory.Schema = 1
	}
	source.Controls = len(controls)
	before := len(uniqueKeys(inventory.Controls))
	inventory.Sources = append(inventory.Sources, source)
	inventory.Controls = append(inventory.Controls, controls...)
	*inventory = Normalize(*inventory)
	after := len(uniqueKeys(inventory.Controls))
	return after - before
}

func uniqueKeys(controls []Control) map[string]bool {
	keys := map[string]bool{}
	for _, control := range controls {
		keys[control.Key()] = true
	}
	return keys
}
