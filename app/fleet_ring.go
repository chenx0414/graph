package main

import "math"

const (
	fleetRingGlobalW     = 260
	fleetRingGlobalH     = 116
	fleetRingThreadW     = 200
	fleetRingThreadH     = 96
	fleetRingChipW       = 132
	fleetRingChipH       = 56
	fleetRingClusterW    = 96
	fleetRingClusterH    = 28
	fleetRingOrphanW     = 132
	fleetRingOrphanH     = 40
	fleetRingDotSize     = 16
	fleetRingDotSmall    = 12
	fleetRingGraphLimit  = 160
	fleetRingMaxThreads  = 12
	fleetRingMaxW        = 800
	fleetRingMaxH        = 740
	fleetRingEdgeSamples = 20
	fleetRingSectorGap   = 2.0
)

type fleetRingNode struct {
	Kind        string
	ID          string
	Agent       fleetAgent
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
	Agent       fleetAgent
	GraphAgents []fleetAgent
	GraphCount  int
	Name        string
	Detail      string
	Orphan      bool
	Aggregate   bool
	Weight      int
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
	items := fleetRingItems(fleetGroups(data))
	graphTotal := 0
	for _, agent := range data.Agents {
		if agent.Kind == "node" || agent.Kind == "child" {
			graphTotal++
		}
	}
	displayedGraph := 0
	for _, item := range items {
		if !item.Aggregate {
			displayedGraph += item.GraphCount
		}
	}
	ring.Width, ring.Height = fleetRingMaxW, fleetRingMaxH
	ring.CX, ring.CY = ring.Width/2, ring.Height/2
	dotsMode := graphTotal <= fleetRingGraphLimit
	var cardW, cardH, ring1X, ring1Y, ring2X, ring2Y float32
	widths, heights := fleetRingFitCandidates(len(items))
	chosen := ""
	for {
		chosen = ""
		for index, width := range widths {
			fitW, fitH, fitRing1X, fitRing1Y, fitRing2X, fitRing2Y, ok := fleetRingFitCandidate(len(items), dotsMode, width, heights[index])
			if !ok {
				continue
			}
			if fitW > fleetRingChipW && fleetRingCardsOverlap(items, fitRing1X, fitRing1Y, fitRing2X, fitRing2Y, fitW, fitH) {
				continue
			}
			if dotsMode {
				capacity := int((fleetEllipsePerimeter(fitRing2X, fitRing2Y) - fleetRingSectorGap*float64(len(items))) / fleetRingDotSize)
				if displayedGraph > capacity {
					continue
				}
			}
			cardW, cardH, ring1X, ring1Y, ring2X, ring2Y = fitW, fitH, fitRing1X, fitRing1Y, fitRing2X, fitRing2Y
			chosen = "fitted"
			break
		}
		if chosen != "" || !dotsMode {
			break
		}
		dotsMode = false
	}
	if chosen == "" {
		cardW, cardH = widths[len(widths)-1], heights[len(heights)-1]
		half := max(cardW, cardH) / 2
		neighbor := float32(fleetRingClusterW / 2)
		if dotsMode {
			neighbor = fleetRingDotSize / 2
		}
		clearance := half + neighbor + 24
		ring2X, ring2Y = fleetRingMaxW/2-70, fleetRingMaxH/2-48
		if dotsMode {
			ring2X, ring2Y = fleetRingMaxW/2-24, fleetRingMaxH/2-24
		}
		ring1X = max(float32(fleetRingGlobalW/2+half+20), ring2X-clearance)
		ring1Y = max(float32(fleetRingGlobalH/2+half+20), ring2Y-clearance)
	}
	ring.Clustered = !dotsMode
	ring.Ring1X, ring.Ring1Y, ring.Ring2X, ring.Ring2Y = ring1X, ring1Y, ring2X, ring2Y
	center := fleetRingNode{Kind: "global", ID: main.ID, Agent: main, Group: -1, W: fleetRingGlobalW, H: fleetRingGlobalH}
	center.X, center.Y = ring.CX-center.W/2, ring.CY-center.H/2
	ring.Nodes = append(ring.Nodes, center)
	arc := newFleetEllipseArc(ring.Ring2X, ring.Ring2Y)
	totalWeight := 0
	for _, item := range items {
		totalWeight += max(1, item.Weight)
	}
	usable := arc.total - fleetRingSectorGap*float64(len(items))
	floorArc := float64(cardW + 1)
	extra := usable - floorArc*float64(len(items))
	if extra < 0 {
		extra = 0
	}
	cursor := 0.0
	minSpacing := math.MaxFloat64
	for index, item := range items {
		arcLen := floorArc + extra*float64(max(1, item.Weight))/float64(totalWeight)
		start, end := cursor, cursor+arcLen
		cursor = end
		threadAngle := arc.angleAt(start + arcLen/2)
		thread := fleetRingNode{
			Kind: "thread", Group: index, Count: item.GraphCount, Aggregate: item.Aggregate, Detail: item.Detail,
			SectorStart: float32(arc.angleAt(start)), SectorEnd: float32(arc.angleAt(end)),
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
		thread.X, thread.Y = ring.CX+ring.Ring1X*float32(math.Cos(threadAngle))-thread.W/2, ring.CY+ring.Ring1Y*float32(math.Sin(threadAngle))-thread.H/2
		ring.Nodes = append(ring.Nodes, thread)
		ring.Edges = append(ring.Edges, fleetRingEdgeOf(main.ID, thread.ID, center.Center(), thread.Center()))
		if item.GraphCount == 0 {
			continue
		}
		switch {
		case ring.Clustered || item.Aggregate:
			pill := fleetRingNode{
				Kind: "cluster", ID: "cluster:" + thread.ID, Agent: thread.Agent, Group: index,
				Aggregate: thread.Aggregate, Detail: thread.Detail, Count: item.GraphCount,
				W: fleetRingClusterW, H: fleetRingClusterH, SectorStart: thread.SectorStart, SectorEnd: thread.SectorEnd,
			}
			pill.X, pill.Y = ring.CX+ring.Ring2X*float32(math.Cos(threadAngle))-pill.W/2, ring.CY+ring.Ring2Y*float32(math.Sin(threadAngle))-pill.H/2
			ring.Nodes = append(ring.Nodes, pill)
			ring.Edges = append(ring.Edges, fleetRingEdgeOf(thread.ID, pill.ID, thread.Center(), pill.Center()))
		default:
			count := item.GraphCount
			spacing := arcLen / float64(count)
			if spacing < minSpacing {
				minSpacing = spacing
			}
			size := float32(fleetRingDotSize)
			if spacing < 20 {
				size = fleetRingDotSmall
			}
			parent := thread
			if item.Orphan {
				parent = center
			}
			for dotIndex, agent := range item.GraphAgents {
				dotArcLen := start + arcLen*(float64(dotIndex)+0.5)/float64(count)
				dotAngle := arc.angleAt(dotArcLen)
				dot := fleetRingNode{Kind: "graph", ID: agent.ID, Agent: agent, Group: index, W: size, H: size,
					SectorStart: thread.SectorStart, SectorEnd: thread.SectorEnd}
				dot.X = ring.CX + ring.Ring2X*float32(math.Cos(dotAngle)) - size/2
				dot.Y = ring.CY + ring.Ring2Y*float32(math.Sin(dotAngle)) - size/2
				ring.Nodes = append(ring.Nodes, dot)
				ring.Edges = append(ring.Edges, fleetRingEdgeOf(parent.ID, dot.ID, parent.Center(), dot.Center()))
			}
		}
	}
	return ring
}

func fleetRingItems(groups []fleetGroup) []fleetRingItem {
	items := []fleetRingItem{}
	hidden := []fleetGroup{}
	for _, group := range groups {
		if len(items) >= fleetRingMaxThreads {
			hidden = append(hidden, group)
			continue
		}
		if group.Orphan {
			items = append(items, fleetRingItem{Name: "未归属", Orphan: true, GraphAgents: group.Agents, GraphCount: len(group.Agents), Weight: max(1, len(group.Agents))})
			continue
		}
		items = append(items, fleetRingItem{
			Agent: group.Project, Name: fleetAgentLabel(group.Project),
			GraphAgents: group.Agents, GraphCount: len(group.Agents), Weight: max(1, len(group.Agents)),
		})
	}
	if len(hidden) == 0 {
		return items
	}
	aggregate := fleetRingItem{Aggregate: true, Name: "其他 " + formatFleetCount(len(hidden)) + " 个项目", Weight: max(1, len(hidden))}
	names := []string{}
	for _, group := range hidden {
		aggregate.GraphAgents = append(aggregate.GraphAgents, group.Agents...)
		aggregate.GraphCount += len(group.Agents)
		if !group.Orphan {
			names = append(names, fleetAgentLabel(group.Project))
		}
	}
	if len(names) > 4 {
		names = append(names[:4], "…")
	}
	aggregate.Detail = "其他 " + formatFleetCount(len(hidden)) + " 个项目 · " + joinFleetMeta(names) + " · 共 " + formatFleetCount(aggregate.GraphCount) + " 个 Graph Agent"
	items = append(items, aggregate)
	return items
}

func fleetRingFitCandidates(count int) ([]float32, []float32) {
	if count > 8 && count <= 12 {
		return []float32{132}, []float32{56}
	}
	if count > 12 {
		return []float32{132, 120, 108, 96}, []float32{56, 50, 46, 40}
	}
	return []float32{200, 180, 160, 150, 144, 132}, []float32{112, 104, 104, 104, 104, 56}
}

func fleetRingFitCandidate(count int, dotsMode bool, width, height float32) (float32, float32, float32, float32, float32, float32, bool) {
	ring2CapX, ring2CapY := float32(fleetRingMaxW/2-24), float32(fleetRingMaxH/2-24)
	neighbor := float32(fleetRingDotSize / 2)
	if !dotsMode {
		ring2CapX, ring2CapY = fleetRingMaxW/2-70, fleetRingMaxH/2-48
		neighbor = fleetRingClusterW / 2
	}
	half := max(width, height) / 2
	clearance := half + neighbor + 24
	ring1X := ring2CapX - clearance
	ring1Y := ring2CapY - clearance
	if ring1X < fleetRingGlobalW/2+half+20 || ring1Y < fleetRingGlobalH/2+half+20 {
		return 0, 0, 0, 0, 0, 0, false
	}
	usable := fleetEllipsePerimeter(ring1X, ring1Y) - fleetRingSectorGap*float64(count)
	if usable < float64(count)*float64(width+1) {
		return 0, 0, 0, 0, 0, 0, false
	}
	return width, height, ring1X, ring1Y, ring1X + clearance, ring1Y + clearance, true
}

func (s *shellState) unusedFleetRingFit(count int, dotsMode bool) {
	_, _, _, _, _, _ = 0, 0, 0, 0, 0, 0
}

func fleetRingThreadBBoxes(items []fleetRingItem, rx, ry, ring2X, ring2Y, width, height float32) []fleetRingNode {
	arc := newFleetEllipseArc(ring2X, ring2Y)
	totalWeight := 0
	for _, item := range items {
		totalWeight += max(1, item.Weight)
	}
	usable := arc.total - fleetRingSectorGap*float64(len(items))
	floorArc := float64(width + 1)
	extra := usable - floorArc*float64(len(items))
	if extra < 0 {
		extra = 0
	}
	cursor := 0.0
	boxes := make([]fleetRingNode, 0, len(items))
	for index, item := range items {
		arcLen := floorArc + extra*float64(max(1, item.Weight))/float64(totalWeight)
		angle := arc.angleAt(cursor + arcLen/2)
		cursor += arcLen
		boxes = append(boxes, fleetRingNode{
			Kind: "thread", ID: item.Name, Group: index,
			X: rx*float32(math.Cos(angle)) - width/2, Y: ry*float32(math.Sin(angle)) - height/2,
			W: width, H: height,
		})
	}
	return boxes
}

func fleetRingCardsOverlap(items []fleetRingItem, rx, ry, ring2X, ring2Y, width, height float32) bool {
	boxes := fleetRingThreadBBoxes(items, rx, ry, ring2X, ring2Y, width, height)
	for first := 0; first < len(boxes); first++ {
		for second := first + 1; second < len(boxes); second++ {
			if boxes[first].X < boxes[second].X+boxes[second].W && boxes[second].X < boxes[first].X+boxes[first].W &&
				boxes[first].Y < boxes[second].Y+boxes[second].H && boxes[second].Y < boxes[first].Y+boxes[first].H {
				return true
			}
		}
	}
	return false
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
