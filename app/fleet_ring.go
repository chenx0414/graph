package main

import "math"

const (
	fleetRingGlobalW     = 260
	fleetRingGlobalH     = 116
	fleetRingThreadW     = 200
	fleetRingThreadH     = 112
	fleetRingChipW       = 132
	fleetRingChipH       = 56
	fleetRingOrphanW     = 132
	fleetRingOrphanH     = 40
	fleetRingGraphW      = 132
	fleetRingGraphH      = 44
	fleetRingGraphLimit  = 12
	fleetRingMaxThreads  = 12
	fleetRingMaxW        = 900
	fleetRingMaxH        = 760
	fleetRingEdgeSamples = 20
	fleetRingSectorGap   = 2.0
)

type fleetRingNode struct {
	Kind        string
	ID          string
	Agent       fleetAgent
	Unit        fleetGraphUnit
	Group       int
	X, Y, W, H  float32
	Count       int
	Aggregate   bool
	Detail      string
	SectorStart float32
	SectorEnd   float32
}

func (node fleetRingNode) Center() [2]float32 {
	return [2]float32{node.X + node.W/2, node.Y + node.H/2}
}

type fleetRingEdge struct {
	FromID string
	ToID   string
	Points [][2]float32
}

type fleetRing struct {
	Width, Height                  float32
	CX, CY                         float32
	Ring1X, Ring1Y, Ring2X, Ring2Y float32
	Nodes                          []fleetRingNode
	Edges                          []fleetRingEdge
	Clustered                      bool
}

type fleetRingItem struct {
	Agent      fleetAgent
	Name       string
	Detail     string
	Orphan     bool
	Aggregate  bool
	GraphTotal int
	Current    *fleetGraphUnit
	Weight     int
}

type fleetEllipseArc struct {
	rx, ry  float32
	lengths []float64
	total   float64
}

func fleetRingLayout(data *fleetSnapshot) fleetRing {
	ring := fleetRing{}
	if data == nil || len(data.Agents) == 0 {
		return ring
	}
	globals := fleetGlobals(data)
	if len(globals) == 0 {
		return ring
	}
	main := globals[0]
	units := fleetGraphUnits(data)
	items := fleetRingItems(fleetGroups(data), fleetGraphTotals(data), units)
	ring.Width, ring.Height = fleetRingMaxW, fleetRingMaxH
	ring.CX, ring.CY = ring.Width/2, ring.Height/2
	cardW, cardH, ring1X, ring1Y, ring2X, ring2Y := fleetRingThreadFit(len(items))
	ring.Ring1X, ring.Ring1Y, ring.Ring2X, ring.Ring2Y = ring1X, ring1Y, ring2X, ring2Y
	center := fleetRingNode{Kind: "global", ID: main.ID, Agent: main, Group: -1, W: fleetRingGlobalW, H: fleetRingGlobalH}
	center.X, center.Y = ring.CX-center.W/2, ring.CY-center.H/2
	ring.Nodes = append(ring.Nodes, center)
	threadArc := newFleetEllipseArc(ring1X, ring1Y)
	totalWeight := 0
	for _, item := range items {
		totalWeight += max(1, item.Weight)
	}
	usable := threadArc.total - fleetRingSectorGap*float64(len(items))
	floorArc := float64(cardW + 1)
	extra := usable - floorArc*float64(len(items))
	if extra < 0 {
		extra = 0
	}
	threads := make([]fleetRingNode, 0, len(items))
	hiddenGraphs := 0
	cursor := 0.0
	for index, item := range items {
		arcLen := floorArc + extra*float64(max(1, item.Weight))/float64(totalWeight)
		start, end := cursor, cursor+arcLen
		cursor = end
		angle := threadArc.angleAt(start + arcLen/2)
		thread := fleetRingNode{
			Kind: "thread", Group: index, Count: item.GraphTotal, Aggregate: item.Aggregate,
			Detail: item.Detail, SectorStart: float32(threadArc.angleAt(start)), SectorEnd: float32(threadArc.angleAt(end)),
			W: cardW, H: cardH,
		}
		switch {
		case item.Aggregate:
			thread.ID = "aggregate"
		case item.Orphan:
			thread.Kind, thread.ID = "orphan", "orphan"
			thread.W, thread.H = fleetRingOrphanW, fleetRingOrphanH
		default:
			thread.ID = item.Agent.ID
			thread.Agent = item.Agent
		}
		thread.X, thread.Y = ring.CX+ring1X*float32(math.Cos(angle))-thread.W/2, ring.CY+ring1Y*float32(math.Sin(angle))-thread.H/2
		ring.Nodes = append(ring.Nodes, thread)
		threads = append(threads, thread)
		ring.Edges = append(ring.Edges, fleetRingEdgeOf(main.ID, thread.ID, center.Center(), thread.Center()))
		if item.Current != nil {
			ring.Nodes = append(ring.Nodes, fleetRingGraphNode(ring, item.Current.TaskID, *item.Current, angle))
			ring.Edges = append(ring.Edges, fleetRingEdgeOf(thread.ID, "graph:"+item.Current.TaskID, thread.Center(), ring.Nodes[len(ring.Nodes)-1].Center()))
			continue
		}
		if item.Aggregate {
			continue
		}
		hiddenGraphs += item.GraphTotal
	}
	if len(items) > 0 && items[len(items)-1].Aggregate {
		aggregateThread := threads[len(threads)-1]
		var count int
		var tokens int64
		var cost float64
		titles := []string{}
		for index, unit := range units {
			if index < fleetRingGraphLimit {
				continue
			}
			count += unit.NodeCount
			tokens += unit.Tokens
			cost += unit.Cost
			if len(titles) < 5 {
				titles = append(titles, unit.Title)
			}
		}
		if count > 0 {
			unit := fleetGraphUnit{TaskID: "aggregate", Title: "其他 " + formatFleetCount(len(units)-fleetRingGraphLimit) + " 个图", NodeCount: count, Tokens: tokens, Cost: cost, Aggregate: true, Detail: joinFleetMeta(titles)}
			angle := threadArc.angleAt(fleetRingSectorMid(threadArc, aggregateThread))
			node := fleetRingGraphNode(ring, "aggregate", unit, angle)
			node.Kind = "graph-aggregate"
			ring.Nodes = append(ring.Nodes, node)
			ring.Edges = append(ring.Edges, fleetRingEdgeOf(aggregateThread.ID, "graph:aggregate", aggregateThread.Center(), node.Center()))
		}
	}
	return ring
}

func fleetRingGraphNode(ring fleetRing, id string, unit fleetGraphUnit, angle float64) fleetRingNode {
	node := fleetRingNode{
		Kind: "graph-unit", ID: "graph:" + id, Unit: unit, Group: -1,
		W: fleetRingGraphW, H: fleetRingGraphH,
	}
	node.X = ring.CX + ring.Ring2X*float32(math.Cos(angle)) - node.W/2
	node.Y = ring.CY + ring.Ring2Y*float32(math.Sin(angle)) - node.H/2
	return node
}

func fleetRingSectorMid(arc fleetEllipseArc, thread fleetRingNode) float64 {
	start := float64(thread.SectorStart)
	end := float64(thread.SectorEnd)
	distanceStart := arc.distanceAt(start)
	distanceEnd := arc.distanceAt(end)
	return arc.angleAt((distanceStart + distanceEnd) / 2)
}

func fleetRingItems(groups []fleetGroup, totals map[string]int, units []fleetGraphUnit) []fleetRingItem {
	current := map[string]fleetGraphUnit{}
	for _, unit := range units {
		current[unit.ThreadID] = unit
	}
	items := []fleetRingItem{}
	hidden := []fleetGroup{}
	for _, group := range groups {
		if len(items) >= fleetRingMaxThreads {
			hidden = append(hidden, group)
			continue
		}
		if group.Orphan {
			unit, ok := current["orphan"]
			items = append(items, fleetRingItem{Name: "未归属", Orphan: true, Weight: max(1, totals["orphan"]), GraphTotal: totals["orphan"], Current: fleetRingUnitPointer(ok, unit)})
			continue
		}
		unit, ok := current[group.Project.ID]
		items = append(items, fleetRingItem{
			Agent: group.Project, Name: fleetAgentLabel(group.Project),
			Weight: max(1, totals[group.Project.ID]), GraphTotal: totals[group.Project.ID],
			Current: fleetRingUnitPointer(ok, unit),
		})
	}
	if len(hidden) > 0 {
		count := 0
		for _, group := range hidden {
			if group.Orphan {
				count += totals["orphan"]
				continue
			}
			count += totals[group.Project.ID]
		}
		items = append(items, fleetRingItem{
			Name: "其他 " + formatFleetCount(len(hidden)) + " 个项目", Detail: "其他 " + formatFleetCount(len(hidden)) + " 个项目",
			Aggregate: true, Weight: max(1, count), GraphTotal: count,
		})
	}
	return items
}

func fleetRingUnitPointer(ok bool, unit fleetGraphUnit) *fleetGraphUnit {
	if !ok {
		return nil
	}
	return &unit
}

func fleetRingThreadFit(count int) (float32, float32, float32, float32, float32, float32) {
	if count > 8 {
		widths := []float32{132, 120, 108, 96}
		heights := []float32{56, 50, 46, 40}
		return fleetRingThreadCandidate(count, widths, heights)
	}
	widths := []float32{200, 180, 160, 150, 144, 132}
	heights := []float32{112, 104, 104, 104, 104, 56}
	return fleetRingThreadCandidate(count, widths, heights)
}

func fleetRingThreadCandidate(count int, widths, heights []float32) (float32, float32, float32, float32, float32, float32) {
	ring1CapX, ring1CapY := float32(fleetRingMaxW/2-70), float32(fleetRingMaxH/2-48)
	neighbor := float32(fleetRingGraphW / 2)
	for index, width := range widths {
		height := heights[index]
		half := max(width, height) / 2
		clearance := half + neighbor + 24
		ring1X := ring1CapX - clearance
		ring1Y := ring1CapY - clearance
		if ring1X < fleetRingGlobalW/2+half+20 || ring1Y < fleetRingGlobalH/2+half+20 {
			continue
		}
		usable := fleetEllipsePerimeter(ring1X, ring1Y) - fleetRingSectorGap*float64(count)
		if usable < float64(count)*float64(width+1) {
			continue
		}
		return width, height, ring1X, ring1Y, ring1X + clearance, ring1Y + clearance
	}
	width, height := widths[len(widths)-1], heights[len(heights)-1]
	half := max(width, height) / 2
	clearance := half + neighbor + 24
	ring1X := max(float32(fleetRingGlobalW/2+half+20), ring1CapX-clearance)
	ring1Y := max(float32(fleetRingGlobalH/2+half+20), ring1CapY-clearance)
	return width, height, ring1X, ring1Y, ring1X + clearance, ring1Y + clearance
}

func fleetEllipsePerimeter(rx, ry float32) float64 {
	a, b := float64(rx), float64(ry)
	return math.Pi * (3*(a+b) - math.Sqrt((3*a+b)*(a+3*b)))
}

func newFleetEllipseArc(rx, ry float32) fleetEllipseArc {
	const steps = 720
	arc := fleetEllipseArc{rx: rx, ry: ry, lengths: make([]float64, steps+1)}
	x0, y0 := float64(rx), 0.0
	for index := 1; index <= steps; index++ {
		angle := 2 * math.Pi * float64(index) / steps
		x, y := float64(rx)*math.Cos(angle), float64(ry)*math.Sin(angle)
		arc.lengths[index] = arc.lengths[index-1] + math.Hypot(x-x0, y-y0)
		x0, y0 = x, y
	}
	arc.total = arc.lengths[steps]
	return arc
}

func (arc fleetEllipseArc) angleAt(distance float64) float64 {
	if distance <= 0 {
		return 0
	}
	if distance >= arc.total {
		return 2 * math.Pi
	}
	low, high := 0, len(arc.lengths)-1
	for low+1 < high {
		mid := (low + high) / 2
		if arc.lengths[mid] <= distance {
			low = mid
		} else {
			high = mid
		}
	}
	span := arc.lengths[high] - arc.lengths[low]
	if span <= 0 {
		return 2 * math.Pi * float64(low) / float64(len(arc.lengths)-1)
	}
	fraction := (distance - arc.lengths[low]) / span
	return 2 * math.Pi * (float64(low) + fraction) / float64(len(arc.lengths)-1)
}

func (arc fleetEllipseArc) distanceAt(angle float64) float64 {
	target := angle * float64(len(arc.lengths)-1) / (2 * math.Pi)
	index := int(target)
	if index < 0 {
		return 0
	}
	if index >= len(arc.lengths)-1 {
		return arc.total
	}
	fraction := target - float64(index)
	return arc.lengths[index] + (arc.lengths[index+1]-arc.lengths[index])*fraction
}

func fleetRingEdgeOf(fromID, toID string, from, to [2]float32) fleetRingEdge {
	return fleetRingEdge{FromID: fromID, ToID: toID, Points: fleetRingEdgePoints(from, to)}
}

func fleetRingEdgePoints(from, to [2]float32) [][2]float32 {
	dx, dy := to[0]-from[0], to[1]-from[1]
	length := float32(math.Hypot(float64(dx), float64(dy)))
	bend := float32(0.08) * length
	norm := float32(math.Hypot(float64(dx), float64(dy))) + 1e-6
	px, py := -dy/norm*bend, dx/norm*bend
	c1 := [2]float32{from[0] + dx/3 + px, from[1] + dy/3 + py}
	c2 := [2]float32{from[0] + dx*2/3 + px, from[1] + dy*2/3 + py}
	points := make([][2]float32, 0, fleetRingEdgeSamples+1)
	for index := 0; index <= fleetRingEdgeSamples; index++ {
		t := float32(index) / float32(fleetRingEdgeSamples)
		mt := 1 - t
		x := mt*mt*mt*from[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t*t*t*to[0]
		y := mt*mt*mt*from[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t*t*t*to[1]
		points = append(points, [2]float32{x, y})
	}
	return points
}
