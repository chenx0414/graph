package appinstance

import (
	"encoding/json"
	"fmt"
	"strings"
)

// This file holds the small, explicit actions the real-window journey lane
// needs. They sit on top of agent-desktop's semantic (headless) delivery: no
// physical cursor, no synthetic events, and every action resolves a fresh ref
// from the accessibility tree, so a stale ref can never silently hit the wrong
// control.

// findInteractive returns the first match that carries a real ref. agent-desktop
// reports both the container row and its interactive child under the same name;
// the container's ref_id is null, so blindly taking matches[0] yields a click
// with an empty ref.
func (d *Desktop) findInteractive(windowID, role, name string, exact bool) (Match, error) {
	args := []string{"find", "--window-id", windowID}
	if role != "" {
		args = append(args, "--role", role)
	}
	if name != "" {
		args = append(args, "--name", name)
	}
	if exact {
		args = append(args, "--exact")
	}
	args = append(args, "--timeout-ms", "20000")
	raw, err := d.call(args...)
	if err != nil {
		return Match{}, err
	}
	var data struct {
		Matches []Match `json:"matches"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return Match{}, err
	}
	for _, match := range data.Matches {
		if strings.TrimSpace(match.Ref) != "" {
			return match, nil
		}
	}
	return Match{}, &Refusal{Code: "no_target", Message: fmt.Sprintf("no interactive element %q in window %s", name, windowID)}
}

// FindByName resolves the first interactive element whose accessible name
// matches. Button-role exact matching is tried first because that is what a
// user actually presses; name-only and contains matching are fallbacks for
// controls whose AX name carries a suffix (for example a row with an unread
// badge).
func (d *Desktop) FindByName(windowID, name string) (Match, error) {
	if strings.TrimSpace(name) != "" {
		if match, err := d.findInteractive(windowID, "button", name, true); err == nil {
			return match, nil
		}
		if match, err := d.findInteractive(windowID, "", name, true); err == nil {
			return match, nil
		}
	}
	return d.findInteractive(windowID, "", name, false)
}

// ClickByName presses the element with this accessible name.
func (d *Desktop) ClickByName(window Window, name string) (Match, error) {
	match, err := d.FindByName(window.ID, name)
	if err != nil {
		return Match{}, err
	}
	if _, err := d.call("click", match.Ref); err != nil {
		return Match{}, err
	}
	return match, nil
}

// SetText replaces the value of a text control with value. It resolves the
// control by role when one is supplied, otherwise by name only.
func (d *Desktop) SetText(window Window, role, name, value string) (Match, error) {
	candidates := []string{role, "textfield", "text", ""}
	var match Match
	var err error
	for _, candidate := range candidates {
		if candidate == "" && role != "" {
			continue
		}
		match, err = d.findInteractive(window.ID, candidate, name, true)
		if err == nil {
			break
		}
	}
	if err != nil {
		match, err = d.FindByName(window.ID, name)
	}
	if err != nil {
		return Match{}, err
	}
	if _, err := d.call("set-value", match.Ref, value); err != nil {
		return Match{}, err
	}
	return match, nil
}

// FocusByName moves keyboard focus to a control.
func (d *Desktop) FocusByName(window Window, name string) (Match, error) {
	match, err := d.FindByName(window.ID, name)
	if err != nil {
		return Match{}, err
	}
	if _, err := d.call("focus", match.Ref); err != nil {
		return Match{}, err
	}
	return match, nil
}

// PressKey sends a key combination to the focused element.
func (d *Desktop) PressKey(window Window, key string) error {
	combo := strings.ToLower(strings.TrimSpace(key))
	if combo == "" {
		return fmt.Errorf("no key given")
	}
	_, err := d.call("press", combo)
	return err
}

// SnapshotDeep reads the whole accessibility tree with real depth. The default
// Snapshot uses --skeleton, which is right for "did the window change?" but
// collapses deep containers; a settings row six levels down disappears from a
// skeleton even though a user can read it. Journeys that assert visible text
// must use this form.
func (d *Desktop) SnapshotDeep(windowID string) (Snapshot, error) {
	raw, err := d.call("snapshot", "--window-id", windowID, "--max-depth", "40", "--compact", "--timeout-ms", "20000")
	if err != nil {
		return Snapshot{}, err
	}
	var data struct {
		RefCount int             `json:"ref_count"`
		Tree     json.RawMessage `json:"tree"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return Snapshot{}, err
	}
	snapshot := Snapshot{RefCount: data.RefCount}
	nodes := []Node{}
	if len(data.Tree) > 0 {
		collectNodes(data.Tree, &nodes)
	}
	snapshot.Nodes = nodes
	return snapshot, nil
}
