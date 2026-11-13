package main

import (
	"fmt"
	"math"
	"testing"
)

func ringGraphFleet() *fleetSnapshot {
	data := &fleetSnapshot{RootID: "g1", Stats: fleetStats{Agents: 10}}
	data.Agents = []fleetAgent{
		{ID: "g1", Kind: "global", Name: "Main", Status: "running", ConversationID: "g1"},
		{ID: "p1", ParentID: "g1", Kind: "project", Name: "项目 A", Status: "running", ConversationID: "p1"},
		{ID: "p2", ParentID: "g1", Kind: "project", Name: "项目 B", Status: "idle", ConversationID: "p2"},
	}
	for index := 0; index < 4; index++ {
		data.Agents = append(data.Agents,
			fleetAgent{ID: fmt.Sprintf("p1-n%d", index), ParentID: "p1", Kind: "node", Name: fmt.Sprintf("a%d", index), Status: "running", TaskID: "tA", NodeID: fmt.Sprintf("n%d", index), Tokens: 100},
			fleetAgent{ID: fmt.Sprintf("p2-n%d", index), ParentID: "p2", Kind: "node", Name: fmt.Sprintf("b%d", index), Status: "done", TaskID: "tB", NodeID: fmt.Sprintf("n%d", index), Tokens: 200},
		)
	}
	return data
}

func ringGraphNode(t *testing.T, ring fleetRing, id string) fleetRingNode {
	t.Helper()
	for _, node := range ring.Nodes {
		if node.ID == id {
			return node
		}
	}
	t.Fatalf("the ring misses %s: %+v", id, ring.Nodes)
	return fleetRingNode{}
}

func TestFleetRingShowsOneGraphUnitPerThread(t *testing.T) {
	ring := fleetRingLayout(ringGraphFleet())
	units, dots := 0, 0
	for _, node := range ring.Nodes {
		switch node.Kind {
		case "graph-unit":
			units++
		case "graph":
			dots++
		}
	}
	if units != 2 || dots != 0 {
		t.Fatalf("the ring shows one graph unit per thread, units %d dots %d", units, dots)
	}
	unit := ringGraphNode(t, ring, "graph:tA")
	if unit.Unit.NodeCount != 4 || unit.Unit.Status != "running" {
		t.Fatalf("the graph unit carries its nodes and status, %+v", unit)
	}
	if unit.W != 132 || unit.H != 44 {
		t.Fatalf("the graph unit keeps its card size, %.0fx%.0f", unit.W, unit.H)
	}
	thread := ringGraphNode(t, ring, "p1")
	if thread.Count != 1 {
		t.Fatalf("the thread counts its graphs, %+v", thread)
	}
	if len(ring.Edges) == 0 {
		t.Fatal("the graph units link to their threads")
	}
}

func TestFleetRingAggregatesExtraGraphUnits(t *testing.T) {
	data := &fleetSnapshot{RootID: "g1", Agents: []fleetAgent{{ID: "g1", Kind: "global", Name: "Main"}}}
	for project := 0; project < 14; project++ {
		pid := fmt.Sprintf("p%02d", project)
		data.Agents = append(data.Agents,
			fleetAgent{ID: pid, ParentID: "g1", Kind: "project", Name: fmt.Sprintf("项目 %d", project)},
			fleetAgent{ID: "n" + pid, ParentID: pid, Kind: "node", Name: "worker", TaskID: "t" + pid, NodeID: "n"},
		)
	}
	ring := fleetRingLayout(data)
	units, aggregates := 0, 0
	for _, node := range ring.Nodes {
		switch node.Kind {
		case "graph-unit":
			units++
		case "graph-aggregate":
			aggregates++
		}
	}
	if units != 12 || aggregates != 1 {
		t.Fatalf("fourteen graphs fold into twelve plus an aggregate, units %d aggregates %d", units, aggregates)
	}
	if ring.Width > fleetRingMaxW || ring.Height > fleetRingMaxH {
		t.Fatalf("the world fits the pane, %.0fx%.0f", ring.Width, ring.Height)
	}
}

func TestFleetRingNodesStayInsideTheWorld(t *testing.T) {
	ring := fleetRingLayout(ringGraphFleet())
	for _, node := range ring.Nodes {
		if node.X < 0 || node.Y < 0 || node.X+node.W > ring.Width || node.Y+node.H > ring.Height {
			t.Fatalf("node %s leaves the world, %+v", node.ID, node)
		}
	}
	center := ringGraphNode(t, ring, "g1")
	for _, node := range ring.Nodes {
		if node.Kind == "thread" && node.X < center.X+center.W && center.X < node.X+node.W && node.Y < center.Y+center.H && center.Y < node.Y+node.H {
			t.Fatalf("thread %s covers main", node.ID)
		}
	}
	_ = math.Hypot(0, 0)
}
