package graph

import (
	"os"
	"testing"
)

func TestTheGraphLayoutWorksWithoutElkjs(t *testing.T) {
	original := ApplicationRoot
	ApplicationRoot = t.TempDir()
	t.Cleanup(func() { ApplicationRoot = original })
	if _, err := os.Stat(ApplicationRoot + "/node_modules/elkjs/lib/elk.bundled.js"); err == nil {
		t.Fatal("the fixture must not ship elkjs")
	}

	input := LayoutInput{
		Nodes: []LayoutNode{{ID: "work", Kind: "agent", Action: "work"}, {ID: "check", Kind: "module", Action: "run"}},
		Edges: []LayoutEdge{{ID: "e1", Source: "work", Target: "check"}},
	}
	layout := LayoutGraph(input, nil)
	work, ok := layout.Positions["work"]
	if !ok {
		t.Fatalf("the layout places work, positions %v", layout.Positions)
	}
	check, ok := layout.Positions["check"]
	if !ok {
		t.Fatalf("the layout places check, positions %v", layout.Positions)
	}
	if work.X == check.X && work.Y == check.Y {
		t.Fatalf("the layout separates the two nodes, got %v %v", work, check)
	}
	if len(layout.Edges) != 1 || len(layout.Edges[0].Points) < 2 {
		t.Fatalf("the layout routes the edge, edges %v", layout.Edges)
	}
}
