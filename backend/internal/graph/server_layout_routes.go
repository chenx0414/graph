package graph

import (
	"fmt"
	"math"
)

func layoutParentMap(input LayoutInput) map[string]string {
	parents := map[string]string{}
	for _, group := range input.Containers {
		parents[group.ID] = group.Parent
	}
	for _, node := range input.Nodes {
		parents[node.ID] = node.Container
	}
	return parents
}

type layoutSearch struct {
	x, y      float64
	direction int
	cost      float64
	priority  float64
	previous  *layoutSearch
}

type layoutFrontier struct{ items []*layoutSearch }

func (frontier *layoutFrontier) push(item *layoutSearch) {
	frontier.items = append(frontier.items, item)
	index := len(frontier.items) - 1
	for index > 0 {
		parent := (index - 1) / 2
		if frontier.items[parent].priority <= item.priority {
			break
		}
		frontier.items[index] = frontier.items[parent]
		index = parent
	}
	frontier.items[index] = item
}

func (frontier *layoutFrontier) pop() *layoutSearch {
	if len(frontier.items) == 0 {
		return nil
	}
	first := frontier.items[0]
	last := frontier.items[len(frontier.items)-1]
	frontier.items = frontier.items[:len(frontier.items)-1]
	if len(frontier.items) == 0 {
		return first
	}
	index := 0
	for index*2+1 < len(frontier.items) {
		child := index*2 + 1
		if child+1 < len(frontier.items) && frontier.items[child+1].priority < frontier.items[child].priority {
			child++
		}
		if last.priority <= frontier.items[child].priority {
			break
		}
		frontier.items[index] = frontier.items[child]
		index = child
	}
	frontier.items[index] = last
	return first
}

func layoutSegmentKey(a, b LayoutPoint) string {
	if a.X < b.X || (a.X == b.X && a.Y < b.Y) {
		return fmt.Sprintf("%v,%v:%v,%v", a.X, a.Y, b.X, b.Y)
	}
	return fmt.Sprintf("%v,%v:%v,%v", b.X, b.Y, a.X, a.Y)
}

// layoutOrthogonalRoutes is the connector walk from orthogonal-routes.ts.
// The exported OrthogonalRoutes stays in that translation; this copy does not share its unexported grid.
func layoutOrthogonalRoutes(edges []LayoutEdge, positions map[string]LayoutPosition, nodeIDs []string) map[string][]LayoutPoint {
	boxes := []LayoutPosition{}
	for _, id := range nodeIDs {
		if box, ok := positions[id]; ok {
			boxes = append(boxes, box)
		}
	}
	margin := float64(layoutGRID * (len(edges) + 6))
	left, right, top, bottom := 0.0, 0.0, 0.0, 0.0
	for _, box := range boxes {
		if box.X < left {
			left = box.X
		}
		if box.X+box.Width > right {
			right = box.X + box.Width
		}
		if box.Y < top {
			top = box.Y
		}
		if box.Y+box.Height > bottom {
			bottom = box.Y + box.Height
		}
	}
	left -= margin
	right += margin
	top -= margin
	bottom += margin
	blocked := func(point LayoutPoint) bool {
		for _, box := range boxes {
			if point.X > box.X-layoutGRID && point.X < box.X+box.Width+layoutGRID && point.Y > box.Y-layoutGRID && point.Y < box.Y+box.Height+layoutGRID {
				return true
			}
		}
		return false
	}
	reserved := map[string]bool{}
	result := map[string][]LayoutPoint{}
	outgoing := map[string]int{}
	incoming := map[string]int{}
	walk := func(start, end LayoutPoint) []LayoutPoint {
		frontier := &layoutFrontier{}
		best := map[string]float64{}
		heuristic := func(point LayoutPoint) float64 {
			return (math.Abs(point.X-end.X) + math.Abs(point.Y-end.Y)) / layoutGRID
		}
		frontier.push(&layoutSearch{x: start.X, y: start.Y, direction: -1, priority: heuristic(start)})
		for {
			current := frontier.pop()
			if current == nil {
				panic(fmt.Errorf("No orthogonal route between graph connectors"))
			}
			key := fmt.Sprintf("%v,%v,%d", current.x, current.y, current.direction)
			if previous, ok := best[key]; ok && current.cost > previous {
				continue
			}
			if current.x == end.X && current.y == end.Y {
				path := []LayoutPoint{}
				for step := current; step != nil; step = step.previous {
					path = append(path, LayoutPoint{X: step.x, Y: step.y})
				}
				for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
					path[i], path[j] = path[j], path[i]
				}
				return path
			}
			steps := [][3]float64{{0, layoutGRID, 0}, {-layoutGRID, 0, 1}, {layoutGRID, 0, 1}, {0, -layoutGRID, 0}}
			for _, step := range steps {
				next := LayoutPoint{X: current.x + step[0], Y: current.y + step[1]}
				direction := int(step[2])
				if next.X < left || next.X > right || next.Y < top || next.Y > bottom || blocked(next) || reserved[layoutSegmentKey(LayoutPoint{X: current.x, Y: current.y}, next)] {
					continue
				}
				cost := current.cost + 1
				if current.direction != -1 && current.direction != direction {
					cost += 0.5
				}
				nextKey := fmt.Sprintf("%v,%v,%d", next.X, next.Y, direction)
				if previous, ok := best[nextKey]; ok && cost >= previous {
					continue
				}
				best[nextKey] = cost
				frontier.push(&layoutSearch{x: next.X, y: next.Y, direction: direction, cost: cost, priority: cost + heuristic(next), previous: current})
			}
		}
	}
	remember := func(points []LayoutPoint) {
		for index := 1; index < len(points); index++ {
			reserved[layoutSegmentKey(points[index-1], points[index])] = true
		}
	}
	simplify := func(points []LayoutPoint) []LayoutPoint {
		kept := []LayoutPoint{}
		for index, point := range points {
			if index == 0 || index == len(points)-1 {
				kept = append(kept, point)
				continue
			}
			before, after := points[index-1], points[index+1]
			if (before.X == point.X && point.X == after.X) || (before.Y == point.Y && point.Y == after.Y) {
				continue
			}
			kept = append(kept, point)
		}
		return kept
	}
	type prepared struct {
		edge          LayoutEdge
		start, end    LayoutPoint
		leave, arrive LayoutPoint
	}
	items := []prepared{}
	for _, edge := range edges {
		source, sourceOK := positions[edge.Source]
		target, targetOK := positions[edge.Target]
		if !sourceOK || !targetOK {
			panic(fmt.Errorf("Missing layout endpoint for %s", edge.ID))
		}
		out := outgoing[edge.Source]
		outgoing[edge.Source] = out + 1
		into := incoming[edge.Target]
		incoming[edge.Target] = into + 1
		start := LayoutPoint{X: source.X + source.Width/2, Y: source.Y + source.Height}
		end := LayoutPoint{X: target.X + target.Width/2, Y: target.Y}
		leave := LayoutPoint{X: start.X, Y: start.Y + layoutGRID*float64(2+out)}
		arrive := LayoutPoint{X: end.X, Y: end.Y - layoutGRID*float64(2+into)}
		stem := func(a, b LayoutPoint) []LayoutPoint {
			points := []LayoutPoint{a}
			dy := float64(layoutGRID)
			if a.Y >= b.Y {
				dy = -layoutGRID
			}
			for y := a.Y + dy; y != b.Y+dy; y += dy {
				points = append(points, LayoutPoint{X: a.X, Y: y})
			}
			return points
		}
		sourceStem := stem(start, leave)
		targetStem := stem(arrive, end)
		for _, point := range append(append([]LayoutPoint{}, sourceStem[1:]...), targetStem[:len(targetStem)-1]...) {
			for _, box := range boxes {
				if point.X > box.X && point.X < box.X+box.Width && point.Y > box.Y && point.Y < box.Y+box.Height {
					panic(fmt.Errorf("Connector stem crosses a node for %s", edge.ID))
				}
			}
		}
		remember(sourceStem)
		remember(targetStem)
		items = append(items, prepared{edge: edge, start: start, end: end, leave: leave, arrive: arrive})
	}
	for _, item := range items {
		path := walk(item.leave, item.arrive)
		remember(path)
		result[item.edge.ID] = append([]LayoutPoint{item.start}, append(simplify(path), item.end)...)
	}
	return result
}
