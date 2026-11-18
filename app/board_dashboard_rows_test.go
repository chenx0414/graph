package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestTheDefaultBoardGivesTheContextCardItsFullHeight(t *testing.T) {
	layout := defaultBoardLayout()
	if len(layout.Children) != 3 {
		t.Fatalf("the default board keeps three rows, got %d", len(layout.Children))
	}
	if got := layout.Children[0].Weight; got != boardContextRowWeight {
		t.Fatalf("the context card row gets its full default height, got %v", got)
	}
	if got := layout.Children[1].Weight; got != boardNetworkRowWeight {
		t.Fatalf("the network row keeps the rest of that space, got %v", got)
	}
	if got := layout.Children[2].Weight; got != boardCollaborationRowWeight {
		t.Fatalf("the collaboration row closes the column, got %v", got)
	}
	for index, slot := range layout.Children {
		if slot.Node.Kind != "panel" {
			t.Fatalf("row %d splits into more panes, node %+v", index, slot.Node)
		}
	}
}

func TestLoadingAnOldBoardRebalancesTheDashboardRows(t *testing.T) {
	dir := t.TempDir()
	old := `{"version":16,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"agent","kind":"agent"},{"id":"trajectory","kind":"trajectory"},
		{"id":"context-overview","kind":"context-overview"},{"id":"agent-network","kind":"agent-network"}],
	 "layout":{"kind":"split","axis":"column","children":[
		{"weight":1.5,"node":{"kind":"panel","panelId":"context-overview"}},
		{"weight":3.5,"node":{"kind":"panel","panelId":"agent-network"}},
		{"weight":3,"node":{"kind":"split","axis":"row","children":[
			{"weight":1,"node":{"kind":"panel","panelId":"agent"}},
			{"weight":1,"node":{"kind":"panel","panelId":"trajectory"}}]}}]}}],"active":0}`
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), []byte(old), 0o600); err != nil {
		t.Fatalf("write the old board: %v", err)
	}
	state := newShellState("http://127.0.0.1:1", "")
	state.loadBoard(dir)
	layout := state.boardPage().Layout
	if layout.Children[0].Weight != 1.75 || layout.Children[1].Weight != 3.25 {
		t.Fatalf("the old default rows move to the new default, got %v/%v",
			layout.Children[0].Weight, layout.Children[1].Weight)
	}
}

func TestLoadingACurrentBoardKeepsAGrowTheUserDragged(t *testing.T) {
	dir := t.TempDir()
	dragged := fmt.Sprintf(`{"version":%d,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"context-overview","kind":"context-overview"},{"id":"agent-network","kind":"agent-network"},
		{"id":"fleet-collaboration","kind":"fleet-collaboration"}],
	 "layout":{"kind":"split","axis":"column","children":[
		{"weight":2.4,"node":{"kind":"panel","panelId":"context-overview"}},
		{"weight":2.6,"node":{"kind":"panel","panelId":"agent-network"}},
		{"weight":3.5,"node":{"kind":"panel","panelId":"fleet-collaboration"}}]}}],"active":0}`, boardLayoutVersion)
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), []byte(dragged), 0o600); err != nil {
		t.Fatalf("write the dragged board: %v", err)
	}
	state := newShellState("http://127.0.0.1:1", "")
	state.loadBoard(dir)
	layout := state.boardPage().Layout
	if layout.Children[0].Weight != 2.4 || layout.Children[1].Weight != 2.6 {
		t.Fatalf("a layout the user dragged stays put, got %v/%v",
			layout.Children[0].Weight, layout.Children[1].Weight)
	}
}

func TestAnOlderBoardFallsBackToTheThreeCardDefault(t *testing.T) {
	dir := t.TempDir()
	old := `{"version":16,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"agent","kind":"agent"},{"id":"trajectory","kind":"trajectory"},
		{"id":"context-overview","kind":"context-overview"},{"id":"agent-network","kind":"agent-network"}],
	 "layout":{"kind":"split","axis":"column","children":[
		{"weight":2.4,"node":{"kind":"panel","panelId":"context-overview"}},
		{"weight":2.6,"node":{"kind":"panel","panelId":"agent-network"}},
		{"weight":3,"node":{"kind":"split","axis":"row","children":[
			{"weight":1,"node":{"kind":"panel","panelId":"agent"}},
			{"weight":1,"node":{"kind":"panel","panelId":"trajectory"}}]}}]}}],"active":0}`
	if err := os.WriteFile(filepath.Join(dir, "whiteboard.json"), []byte(old), 0o600); err != nil {
		t.Fatalf("write the old board: %v", err)
	}
	state := newShellState("http://127.0.0.1:1", "")
	state.loadBoard(dir)
	page := state.boardPage()
	if leaves := boardLeafIDs(&page.Layout); len(leaves) != 3 || leaves[0] != "context-overview" || leaves[1] != "agent-network" || leaves[2] != "fleet-collaboration" {
		t.Fatalf("an old board takes the three card default, leaves %v", leaves)
	}
	if kinds := len(page.Panels); kinds != 3 {
		t.Fatalf("an old board keeps exactly three modules, panels %+v", page.Panels)
	}
}
