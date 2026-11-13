package main

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func ringFleet(graphPerProject []int) *fleetSnapshot {
	data := &fleetSnapshot{RootID: "g1", Stats: fleetStats{Agents: 1, Running: 1}}
	data.Agents = append(data.Agents, fleetAgent{ID: "g1", Kind: "global", Name: "Main", Status: "running", Tokens: 1000})
	for project, count := range graphPerProject {
		projectID := fmt.Sprintf("p%02d", project)
		title := fmt.Sprintf("项目 %d", project)
		data.Agents = append(data.Agents, fleetAgent{ID: projectID, ParentID: "g1", Kind: "project", Name: title, ProjectID: title, ConversationID: projectID, Status: "running", Tokens: 500})
		for node := 0; node < count; node++ {
			data.Agents = append(data.Agents, fleetAgent{
				ID: fmt.Sprintf("%s-n%02d", projectID, node), ParentID: projectID, Kind: "node",
				Name: fmt.Sprintf("node-%02d-%02d", project, node), Status: "running", Tokens: 100,
			})
		}
	}
	return data
}

func ringNodeOf(ring fleetRing, kind, id string) (fleetRingNode, bool) {
	for _, node := range ring.Nodes {
		if node.Kind == kind && node.ID == id {
			return node, true
		}
	}
	return fleetRingNode{}, false
}

func TestFleetRingLayoutCentersMainAndRingsTheAgents(t *testing.T) {
	data := ringFleet([]int{2})
	ring := fleetRingLayout(data)
	if ring.Width <= 0 || ring.Width > 800 || ring.Height > 740 {
		t.Fatalf("the ring world fits the window, %.0fx%.0f", ring.Width, ring.Height)
	}
	center, ok := ringNodeOf(ring, "global", "g1")
	if !ok {
		t.Fatalf("the layout misses the main agent, nodes %+v", ring.Nodes)
	}
	if delta := center.X + center.W/2 - ring.Width/2; delta < -1 || delta > 1 {
		t.Fatalf("the main agent is not centered: %+v in %.0fx%.0f", center, ring.Width, ring.Height)
	}
	if delta := center.Y + center.H/2 - ring.Height/2; delta < -1 || delta > 1 {
		t.Fatalf("the main agent is not centered: %+v in %.0fx%.0f", center, ring.Width, ring.Height)
	}
	if center.W != 260 || center.H != 116 {
		t.Fatalf("the main card keeps its size, %+v", center)
	}
	thread, ok := ringNodeOf(ring, "thread", "p00")
	if !ok {
		t.Fatalf("the layout misses the thread ring, nodes %+v", ring.Nodes)
	}
	graph, ok := ringNodeOf(ring, "graph", "p00-n00")
	if !ok {
		t.Fatalf("the layout misses the graph ring, nodes %+v", ring.Nodes)
	}
	radiusOf := func(node fleetRingNode, rx, ry float32) float64 {
		x := float64(node.X+node.W/2-ring.CX) / float64(rx)
		y := float64(node.Y+node.H/2-ring.CY) / float64(ry)
		return math.Hypot(x, y)
	}
	if value := radiusOf(thread, ring.Ring1X, ring.Ring1Y); math.Abs(value-1) > 0.02 {
		t.Fatalf("the thread sits on the first ring, radius %.3f", value)
	}
	if value := radiusOf(graph, ring.Ring2X, ring.Ring2Y); math.Abs(value-1) > 0.02 {
		t.Fatalf("the graph agent sits on the second ring, radius %.3f", value)
	}
	if ring.Ring2X <= ring.Ring1X || ring.Ring2Y <= ring.Ring1Y {
		t.Fatalf("the second ring encloses the first, %.0f/%.0f vs %.0f/%.0f", ring.Ring2X, ring.Ring2Y, ring.Ring1X, ring.Ring1Y)
	}
	if len(ring.Edges) != 3 {
		t.Fatalf("every pair of agents is linked, edges %d", len(ring.Edges))
	}
}

func TestFleetRingEdgesAreCompleteSampledCurves(t *testing.T) {
	ring := fleetRingLayout(ringFleet([]int{2}))
	if len(ring.Edges) == 0 {
		t.Fatal("the ring layout draws no edges")
	}
	nodes := map[string]fleetRingNode{}
	for _, node := range ring.Nodes {
		nodes[node.ID] = node
	}
	for _, edge := range ring.Edges {
		if len(edge.Points) < 21 {
			t.Fatalf("edge %s→%s has %d points, want a sampled curve", edge.FromID, edge.ToID, len(edge.Points))
		}
		from, fromOK := nodes[edge.FromID]
		to, toOK := nodes[edge.ToID]
		if !fromOK || !toOK {
			t.Fatalf("edge %s→%s refers to unknown nodes", edge.FromID, edge.ToID)
		}
		first := edge.Points[0]
		last := edge.Points[len(edge.Points)-1]
		if delta := first[0] - (from.X + from.W/2); delta < -0.5 || delta > 0.5 {
			t.Fatalf("edge %s→%s starts at %v, not the parent center %+v", edge.FromID, edge.ToID, first, from)
		}
		if delta := first[1] - (from.Y + from.H/2); delta < -0.5 || delta > 0.5 {
			t.Fatalf("edge %s→%s starts at %v, not the parent center %+v", edge.FromID, edge.ToID, first, from)
		}
		if delta := last[0] - (to.X + to.W/2); delta < -0.5 || delta > 0.5 {
			t.Fatalf("edge %s→%s ends at %v, not the child center %+v", edge.FromID, edge.ToID, last, to)
		}
		if delta := last[1] - (to.Y + to.H/2); delta < -0.5 || delta > 0.5 {
			t.Fatalf("edge %s→%s ends at %v, not the child center %+v", edge.FromID, edge.ToID, last, to)
		}
	}
}

func TestFleetRingSectorsFollowTheGraphCount(t *testing.T) {
	data := &fleetSnapshot{RootID: "g1", Agents: []fleetAgent{{ID: "g1", Kind: "global", Name: "Main"}}}
	data.Agents = append(data.Agents,
		fleetAgent{ID: "p1", ParentID: "g1", Kind: "project", Name: "少"},
		fleetAgent{ID: "p1-n1", ParentID: "p1", Kind: "node", Name: "a"},
		fleetAgent{ID: "p2", ParentID: "g1", Kind: "project", Name: "多"},
	)
	for index := 0; index < 5; index++ {
		data.Agents = append(data.Agents, fleetAgent{ID: fmt.Sprintf("p2-n%d", index), ParentID: "p2", Kind: "node", Name: fmt.Sprintf("b%d", index)})
	}
	ring := fleetRingLayout(data)
	p1, _ := ringNodeOf(ring, "thread", "p1")
	p2, _ := ringNodeOf(ring, "thread", "p2")
	p1Span := p1.SectorEnd - p1.SectorStart
	p2Span := p2.SectorEnd - p2.SectorStart
	if p2Span <= p1Span*3 {
		t.Fatalf("a project with five graph agents gets a wider sector: p1 %.3f p2 %.3f", p1Span, p2Span)
	}
	if p1.SectorEnd > p2.SectorStart+0.001 {
		t.Fatalf("the sectors do not tile the ring: p1 %.3f..%.3f p2 %.3f..%.3f", p1.SectorStart, p1.SectorEnd, p2.SectorStart, p2.SectorEnd)
	}
	for index := 0; index < 5; index++ {
		node, _ := ringNodeOf(ring, "graph", fmt.Sprintf("p2-n%d", index))
		x := float64(node.X+node.W/2-ring.CX) / float64(ring.Ring2X)
		y := float64(node.Y+node.H/2-ring.CY) / float64(ring.Ring2Y)
		angle := math.Atan2(y, x)
		relative := math.Mod(angle-float64(p2.SectorStart)+4*math.Pi, 2*math.Pi)
		span := float64(p2.SectorEnd - p2.SectorStart)
		if relative < 0.02 || relative > span-0.02 {
			t.Fatalf("graph agent %d leaves its project sector: relative %.3f span %.3f", index, relative, span)
		}
	}
}

func TestFleetRingClustersAThousandGraphAgents(t *testing.T) {
	data := thousandAgentFleet()
	ring := fleetRingLayout(data)
	threads, clusters, graphs := 0, 0, 0
	for _, node := range ring.Nodes {
		switch node.Kind {
		case "thread":
			threads++
		case "cluster":
			clusters++
		case "graph":
			graphs++
		}
	}
	if threads != 13 || clusters != 13 || graphs != 0 {
		t.Fatalf("a thousand graph agents collapse to twelve threads and an aggregate: threads %d clusters %d graphs %d", threads, clusters, graphs)
	}
	if !ring.Clustered {
		t.Fatal("the layout reports the clustered form")
	}
	aggregate, ok := ringNodeOf(ring, "thread", "aggregate")
	if !ok {
		t.Fatalf("the hidden projects get an aggregate thread, nodes %+v", ring.Nodes)
	}
	if aggregate.Count != 540 || !aggregate.Aggregate {
		t.Fatalf("the aggregate thread folds the remaining graph agents, %+v", aggregate)
	}
	if ring.Width > 800 || ring.Height > 740 {
		t.Fatalf("the clustered world fits the window, %.0fx%.0f", ring.Width, ring.Height)
	}
}

func TestFleetRingKeepsGraphDotsApart(t *testing.T) {
	counts := make([]int, 12)
	for index := range counts {
		if index < 8 {
			counts[index] = 11
			continue
		}
		counts[index] = 10
	}
	ring := fleetRingLayout(ringFleet(counts))
	dots := []fleetRingNode{}
	for _, node := range ring.Nodes {
		if node.Kind == "graph" {
			dots = append(dots, node)
		}
	}
	if len(dots) != 128 {
		t.Fatalf("the ring keeps every graph agent as a dot, dots %d", len(dots))
	}
	for first := 0; first < len(dots); first++ {
		for second := first + 1; second < len(dots); second++ {
			dx := dots[first].X + dots[first].W/2 - (dots[second].X + dots[second].W/2)
			dy := dots[first].Y + dots[first].H/2 - (dots[second].Y + dots[second].H/2)
			if distance := math.Hypot(float64(dx), float64(dy)); distance < float64(fleetRingDotSize) {
				t.Fatalf("graph dots %s and %s sit %.1f apart", dots[first].ID, dots[second].ID, distance)
			}
		}
	}
}

func TestFleetRingPutsOrphansOnTheRingLinkedToMain(t *testing.T) {
	data := &fleetSnapshot{RootID: "g1", Agents: []fleetAgent{
		{ID: "g1", Kind: "global", Name: "Main"},
		{ID: "lost", ParentID: "gone", Kind: "node", Name: "lost-node"},
	}}
	ring := fleetRingLayout(data)
	orphan, ok := ringNodeOf(ring, "orphan", "orphan")
	if !ok {
		t.Fatalf("the orphan group takes a thread slot, nodes %+v", ring.Nodes)
	}
	if orphan.W <= 0 || orphan.H <= 0 {
		t.Fatalf("the orphan thread keeps a card size, %+v", orphan)
	}
	lost, ok := ringNodeOf(ring, "graph", "lost")
	if !ok {
		t.Fatalf("the orphan graph agent sits on the second ring, nodes %+v", ring.Nodes)
	}
	if lost.X+lost.W/2 < 0 || lost.Y+lost.H/2 < 0 {
		t.Fatalf("orphan graph agent has an invalid position, %+v", lost)
	}
	found := false
	for _, edge := range ring.Edges {
		if edge.FromID == "g1" && edge.ToID == "lost" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the orphan graph agent links to the main agent, edges %+v", ring.Edges)
	}
}

func TestFleetRingKeepsEveryNodeInsideTheWorld(t *testing.T) {
	counts := make([]int, 12)
	for index := range counts {
		counts[index] = 11
	}
	for name, data := range map[string]*fleetSnapshot{
		"129":  ringFleet(counts),
		"1000": thousandAgentFleet(),
	} {
		ring := fleetRingLayout(data)
		if ring.Width > 800 || ring.Height > 740 {
			t.Fatalf("%s: the world fits a 910 wide window, %.0fx%.0f", name, ring.Width, ring.Height)
		}
		for _, node := range ring.Nodes {
			if node.X < 0 || node.Y < 0 || node.X+node.W > ring.Width || node.Y+node.H > ring.Height {
				t.Fatalf("%s: node %s leaves the world, %+v in %.0fx%.0f", name, node.ID, node, ring.Width, ring.Height)
			}
		}
	}
}

func TestFleetRingAggregatesBeyondTwelveThreads(t *testing.T) {
	counts := make([]int, 20)
	for index := range counts {
		counts[index] = 2
	}
	ring := fleetRingLayout(ringFleet(counts))
	threads, dots, clusters := 0, 0, 0
	for _, node := range ring.Nodes {
		switch node.Kind {
		case "thread":
			threads++
		case "graph":
			dots++
		case "cluster":
			clusters++
		}
	}
	if threads != 13 || clusters != 1 || dots != 24 {
		t.Fatalf("twenty threads fold the last eight: threads %d dots %d clusters %d", threads, dots, clusters)
	}
	aggregate, ok := ringNodeOf(ring, "thread", "aggregate")
	if !ok || aggregate.Count != 16 || !strings.Contains(aggregate.Detail, "其他 8 个项目") {
		t.Fatalf("the aggregate thread describes the hidden projects, %+v", aggregate)
	}
}

func TestFleetRingThreadCardsPickTheirSize(t *testing.T) {
	few := fleetRingLayout(ringFleet([]int{1}))
	thread, ok := ringNodeOf(few, "thread", "p00")
	if !ok || thread.H < 104 {
		t.Fatalf("a single thread keeps a readable full card, %+v", thread)
	}
	twelve := fleetRingLayout(ringFleet(make([]int, 12)))
	thread, ok = ringNodeOf(twelve, "thread", "p00")
	if !ok || thread.W != 132 || thread.H != 56 {
		t.Fatalf("twelve threads get compact chips, %+v", thread)
	}
}

func TestFleetRingDotsKeepTheirMinimumSpacing(t *testing.T) {
	data := ringFleet([]int{9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10})
	ring := fleetRingLayout(data)
	dots := []fleetRingNode{}
	for _, node := range ring.Nodes {
		if node.Kind == "graph" {
			dots = append(dots, node)
		}
	}
	if len(dots) != 119 {
		t.Fatalf("the ring keeps every graph agent as a dot, dots %d", len(dots))
	}
	smallest := math.MaxFloat64
	for first := 0; first < len(dots); first++ {
		for second := first + 1; second < len(dots); second++ {
			dx := float64(dots[first].X + dots[first].W/2 - (dots[second].X + dots[second].W/2))
			dy := float64(dots[first].Y + dots[first].H/2 - (dots[second].Y + dots[second].H/2))
			if distance := math.Hypot(dx, dy); distance < smallest {
				smallest = distance
			}
		}
	}
	if smallest < 16 {
		t.Fatalf("graph dots keep a 16pt distance, smallest %.2f", smallest)
	}
}

func realRingFleet() *fleetSnapshot {
	data := ringFleet([]int{15, 15, 15, 15, 15, 15, 15, 14})
	data.Agents = append(data.Agents, fleetAgent{ID: "lost-1", ParentID: "missing-project", Kind: "node", Name: "未归属节点", Status: "idle"})
	return data
}

func ringThreadBoxes(ring fleetRing) []fleetRingNode {
	boxes := []fleetRingNode{}
	for _, node := range ring.Nodes {
		if node.Kind == "thread" || node.Kind == "orphan" {
			boxes = append(boxes, node)
		}
	}
	return boxes
}

func rectsIntersect(a, b fleetRingNode) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}

func pointRectDistance(x, y float32, node fleetRingNode) float64 {
	dx := float64(max(0, max(node.X-x, x-(node.X+node.W))))
	dy := float64(max(0, max(node.Y-y, y-(node.Y+node.H))))
	return math.Hypot(dx, dy)
}

func TestFleetRingUsesChipsForNineThreads(t *testing.T) {
	ring := fleetRingLayout(realRingFleet())
	boxes := ringThreadBoxes(ring)
	if len(boxes) != 9 {
		t.Fatalf("the real fleet has nine thread cards, got %d: %+v", len(boxes), boxes)
	}
	for _, node := range boxes {
		if node.Kind == "thread" && (node.W != 132 || node.H != 56) {
			t.Fatalf("nine threads use compact chips, got %s %.0fx%.0f", node.ID, node.W, node.H)
		}
		if node.W > 132 {
			t.Fatalf("no full card survives at nine threads, got %s %.0fx%.0f", node.ID, node.W, node.H)
		}
	}
}

func TestFleetRingThreadCardsDoNotOverlap(t *testing.T) {
	ring := fleetRingLayout(realRingFleet())
	boxes := ringThreadBoxes(ring)
	for first := 0; first < len(boxes); first++ {
		for second := first + 1; second < len(boxes); second++ {
			if rectsIntersect(boxes[first], boxes[second]) {
				t.Fatalf("thread cards %s and %s overlap: %+v %+v", boxes[first].ID, boxes[second].ID, boxes[first], boxes[second])
			}
		}
	}
}

func TestFleetRingGraphDotsClearThreadCards(t *testing.T) {
	ring := fleetRingLayout(realRingFleet())
	boxes := ringThreadBoxes(ring)
	for _, node := range ring.Nodes {
		if node.Kind != "graph" {
			continue
		}
		radius := float64(node.W / 2)
		for _, box := range boxes {
			if distance := pointRectDistance(node.X+node.W/2, node.Y+node.H/2, box); distance <= radius {
				t.Fatalf("graph dot %s touches thread card %s: distance %.1f radius %.1f", node.ID, box.ID, distance, radius)
			}
		}
	}
}

func TestFleetRingMainIsNotCoveredByThreads(t *testing.T) {
	ring := fleetRingLayout(realRingFleet())
	center, ok := ringNodeOf(ring, "global", "g1")
	if !ok {
		t.Fatalf("the layout misses the main agent: %+v", ring.Nodes)
	}
	for _, node := range ringThreadBoxes(ring) {
		if rectsIntersect(center, node) {
			t.Fatalf("thread card %s covers main: %+v vs %+v", node.ID, node, center)
		}
	}
}

func realDaemonFleet() *fleetSnapshot {
	data := ringFleet([]int{12, 12, 12, 12, 12, 12, 12})
	for index := 0; index < 35; index++ {
		data.Agents = append(data.Agents, fleetAgent{
			ID: "orphan-" + string(rune('a'+index)), ParentID: "missing-project", Kind: "node",
			Name: "未归属节点", Status: "idle",
		})
	}
	return data
}

func TestFleetRingEightThreadsKeepReadableCards(t *testing.T) {
	ring := fleetRingLayout(realDaemonFleet())
	boxes := ringThreadBoxes(ring)
	if len(boxes) != 8 {
		t.Fatalf("the real daemon fleet has eight thread cards, got %d", len(boxes))
	}
	for _, node := range boxes {
		if node.Kind == "thread" && node.H < 104 {
			t.Fatalf("full thread cards stay readable at eight threads, %s is %.0fx%.0f", node.ID, node.W, node.H)
		}
	}
	if ring.Width > 800 || ring.Height > 740 {
		t.Fatalf("the world fits the pane, %.0fx%.0f", ring.Width, ring.Height)
	}
	for _, node := range ring.Nodes {
		if node.X < 0 || node.Y < 0 || node.X+node.W > ring.Width || node.Y+node.H > ring.Height {
			t.Fatalf("node %s leaves the world, %+v", node.ID, node)
		}
	}
	for first := 0; first < len(boxes); first++ {
		for second := first + 1; second < len(boxes); second++ {
			if rectsIntersect(boxes[first], boxes[second]) {
				t.Fatalf("thread cards %s and %s overlap", boxes[first].ID, boxes[second].ID)
			}
		}
	}
}
