package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheDefaultBoardGivesTheContextCardItsFullHeight(t *testing.T) {
	layout := defaultBoardLayout()
	if len(layout.Children) != 3 {
		t.Fatalf("the default board keeps three rows, got %d", len(layout.Children))
	}
	if got := layout.Children[0].Weight; got != 1.75 {
		t.Fatalf("the context card row gets its full default height, got %v", got)
	}
	if got := layout.Children[1].Weight; got != 3.25 {
		t.Fatalf("the network row keeps the rest of that space, got %v", got)
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

func TestLoadingAnOldBoardKeepsAGrowTheUserDragged(t *testing.T) {
	dir := t.TempDir()
	dragged := `{"version":16,"pages":[{"id":"board","title":"白板","panels":[
		{"id":"agent","kind":"agent"},{"id":"trajectory","kind":"trajectory"},
		{"id":"context-overview","kind":"context-overview"},{"id":"agent-network","kind":"agent-network"}],
	 "layout":{"kind":"split","axis":"column","children":[
		{"weight":2.4,"node":{"kind":"panel","panelId":"context-overview"}},
		{"weight":2.6,"node":{"kind":"panel","panelId":"agent-network"}},
		{"weight":3,"node":{"kind":"split","axis":"row","children":[
			{"weight":1,"node":{"kind":"panel","panelId":"agent"}},
			{"weight":1,"node":{"kind":"panel","panelId":"trajectory"}}]}}]}}],"active":0}`
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
