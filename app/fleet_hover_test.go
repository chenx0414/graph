package main

import (
	"image"
	"testing"

	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

func rectDiffers(before, after *image.RGBA, rect ui.Rect) bool {
	for y := int(rect.Y); y < int(rect.Y+rect.H); y++ {
		for x := int(rect.X); x < int(rect.X+rect.W); x++ {
			at := y*before.Stride + x*4
			if at < 0 || at+3 >= len(before.Pix) || at+3 >= len(after.Pix) {
				continue
			}
			if before.Pix[at] != after.Pix[at] || before.Pix[at+1] != after.Pix[at+1] || before.Pix[at+2] != after.Pix[at+2] {
				return true
			}
		}
	}
	return false
}

func TestHoveringLightsTheEdgesThatTouchTheHoveredNode(t *testing.T) {
	data, err := parseFleet([]byte(fleetSampleJSON))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	ring := fleetRingLayout(data)
	unitID := ""
	for _, node := range ring.Nodes {
		if node.Kind == "graph-unit" {
			unitID = node.ID
		}
	}
	if unitID != "graph:t1" {
		t.Fatalf("the sample graph unit is %q", unitID)
	}
	lit := []string{}
	for _, edge := range ring.Edges {
		_, alpha := fleetEdgePaint(edge.FromID, edge.ToID, unitID, gwtheme.Stroke, fleetRingEdgeAlpha)
		if alpha == fleetHoverEdgeAlpha {
			lit = append(lit, edge.FromID+"->"+edge.ToID)
		}
	}
	if len(lit) != 1 || lit[0] != "p1->graph:t1" {
		t.Fatalf("hovering the graph unit lights exactly its own edge, lit %v", lit)
	}
	for _, edge := range ring.Edges {
		if _, alpha := fleetEdgePaint(edge.FromID, edge.ToID, "", gwtheme.Stroke, fleetRingEdgeAlpha); alpha != fleetRingEdgeAlpha {
			t.Fatalf("no hover keeps every edge at rest, %v at alpha %v", edge.FromID, alpha)
		}
	}
}

func TestEveryFleetNodeKindAnswersThePointerTheSameWay(t *testing.T) {
	state := fleetServerShell(t, fleetSampleServer)
	tester := openFleetTester(t, state)
	state.openModuleWithScope("agent-network", "fleet")
	tester = frames(tester)
	cards := []struct{ label, id string }{
		{"编队 Agent 主控", "g1"},
		{"编队 Agent 13-Graph", "p1"},
		{"编队图 实现四栏页面", "graph:t1"},
	}
	for _, want := range cards {
		card, ok := tester.Find(want.label)
		if !ok {
			t.Fatalf("the %q card never rendered, texts %q", want.label, tester.Texts())
		}
		tester.Move(4, 4)
		tester = frames(tester)
		rest := tester.Image()
		tester.Move(card.X+card.W/2, card.Y+card.H/2)
		tester = frames(tester)
		if state.fleet.hoverID != want.id {
			t.Fatalf("hovering %q must hover the node itself, hovered %q want %q", want.label, state.fleet.hoverID, want.id)
		}
		if !rectDiffers(rest, tester.Image(), card) {
			t.Fatalf("hovering %q paints nothing on the card", want.label)
		}
	}
}
