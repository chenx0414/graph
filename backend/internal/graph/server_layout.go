package graph

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
)

const layoutGRID = 16

// LayoutNode is one box the console lays out.
type LayoutNode struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Action    string `json:"action,omitempty"`
	Container string `json:"container,omitempty"`
}

// LayoutGroup is a container in the graph.
type LayoutGroup struct {
	ID     string `json:"id"`
	Parent string `json:"parent,omitempty"`
}

// LayoutEdge connects two ids.
type LayoutEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

// LayoutInput is the topology to place.
type LayoutInput struct {
	Nodes      []LayoutNode  `json:"nodes"`
	Containers []LayoutGroup `json:"containers,omitempty"`
	Edges      []LayoutEdge  `json:"edges"`
}

// LayoutPosition is one snapped box.
type LayoutPosition struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// LayoutPoint is one orthogonal route vertex.
type LayoutPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// LayoutRoutedEdge is an edge plus its points when a route exists.
type LayoutRoutedEdge struct {
	ID     string        `json:"id"`
	Source string        `json:"source"`
	Target string        `json:"target"`
	Points []LayoutPoint `json:"points,omitempty"`
}

// GraphLayout is the placed graph.
type GraphLayout struct {
	Positions map[string]LayoutPosition `json:"positions"`
	Edges     []LayoutRoutedEdge        `json:"edges"`
}

// LayoutPrevious is the last placement reusePositions may keep.
type LayoutPrevious struct {
	Input  LayoutInput
	Layout GraphLayout
}

func layoutRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

func layoutSnap(value float64) float64 {
	return layoutRound(value/layoutGRID) * layoutGRID
}

// layoutPresentationNode is the layout node as the presentation module sees it.
func layoutPresentationNode(node LayoutNode) GraphNodeLike {
	return GraphNodeLike{Id: node.ID, Kind: node.Kind, Action: node.Action}
}

// layoutNodeSize is the box the presentation module owns. The browser draws the
// same width, so the rule lives in one place.
func layoutNodeSize(node LayoutNode) (float64, float64) {
	box := GraphNodeSize(layoutPresentationNode(node))
	return float64(box.Width), float64(box.Height)
}

// LayoutGraph places nodes with elkjs, then draws orthogonal connectors in Go.
func LayoutGraph(input LayoutInput, previous *LayoutPrevious) GraphLayout {
	containers := input.Containers
	nested := map[string]bool{}
	for _, node := range input.Nodes {
		if node.Container != "" {
			nested[node.ID] = true
		}
	}
	byParent := map[string][]string{}
	for _, container := range containers {
		byParent[container.Parent] = append(byParent[container.Parent], container.ID)
	}
	outgoingDegree := map[string]int{}
	incomingDegree := map[string]int{}
	for _, edge := range input.Edges {
		outgoingDegree[edge.Source]++
		incomingDegree[edge.Target]++
	}
	maxDegree := 1
	for _, node := range input.Nodes {
		if outgoingDegree[node.ID] > maxDegree {
			maxDegree = outgoingDegree[node.ID]
		}
		if incomingDegree[node.ID] > maxDegree {
			maxDegree = incomingDegree[node.ID]
		}
	}
	layerSpacing := strconv.Itoa(64 + 32*maxDegree)
	var build func(string) map[string]any
	box := func(node LayoutNode) map[string]any {
		width, height := layoutNodeSize(node)
		return map[string]any{
			"id": node.ID, "width": width, "height": height,
			"layoutOptions": map[string]any{"elk.portConstraints": "FIXED_POS"},
			"ports": []any{
				map[string]any{"id": node.ID + ":in", "x": width / 2, "y": 0, "width": 0, "height": 0, "layoutOptions": map[string]any{"elk.port.side": "NORTH"}},
				map[string]any{"id": node.ID + ":out", "x": width / 2, "y": height, "width": 0, "height": 0, "layoutOptions": map[string]any{"elk.port.side": "SOUTH"}},
			},
		}
	}
	nodeChildren := func(parent string) []any {
		out := []any{}
		for _, node := range input.Nodes {
			if node.Container == parent {
				out = append(out, box(node))
			}
		}
		return out
	}
	build = func(id string) map[string]any {
		children := []any{}
		for _, child := range byParent[id] {
			children = append(children, build(child))
		}
		children = append(children, nodeChildren(id)...)
		return map[string]any{
			"id": id,
			"layoutOptions": map[string]any{
				"elk.padding": "[32,32,32,32]", "elk.algorithm": "layered", "elk.direction": "DOWN",
				"elk.spacing.nodeNode": "64", "elk.layered.spacing.nodeNodeBetweenLayers": layerSpacing,
			},
			"children": children,
		}
	}
	nodeIDs := map[string]bool{}
	for _, node := range input.Nodes {
		nodeIDs[node.ID] = true
	}
	edges := []any{}
	for _, edge := range input.Edges {
		source, target := edge.Source, edge.Target
		if nodeIDs[source] {
			source += ":out"
		}
		if nodeIDs[target] {
			target += ":in"
		}
		edges = append(edges, map[string]any{"id": edge.ID, "sources": []string{source}, "targets": []string{target}})
	}
	children := []any{}
	for _, id := range byParent[""] {
		children = append(children, build(id))
	}
	for _, node := range input.Nodes {
		if !nested[node.ID] {
			children = append(children, box(node))
		}
	}
	graph := map[string]any{
		"id": "root",
		"layoutOptions": map[string]any{
			"elk.algorithm": "layered", "elk.direction": "DOWN", "elk.hierarchyHandling": "INCLUDE_CHILDREN",
			"elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "56",
			"elk.layered.spacing.nodeNodeBetweenLayers": layerSpacing, "elk.layered.spacing.edgeNodeBetweenLayers": "28",
			"elk.layered.spacing.edgeEdgeBetweenLayers": "20", "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
			"elk.layered.mergeEdges": "false", "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
		},
		"children": children,
		"edges":    edges,
	}
	laid := layoutElk(graph)
	positions := map[string]LayoutPosition{}
	var walk func(map[string]any, float64, float64)
	walk = func(node map[string]any, ox, oy float64) {
		id, _ := node["id"].(string)
		if id == "" {
			return
		}
		x := layoutSnap(ox + layoutNumber(node["x"]))
		y := layoutSnap(oy + layoutNumber(node["y"]))
		width := math.Ceil(layoutNumberDefault(node["width"], 160)/(layoutGRID*2)) * layoutGRID * 2
		height := math.Ceil(layoutNumberDefault(node["height"], 64)/layoutGRID) * layoutGRID
		positions[id] = LayoutPosition{X: x, Y: y, Width: width, Height: height}
		children, _ := node["children"].([]any)
		for _, child := range children {
			object, _ := child.(map[string]any)
			if object != nil {
				walk(object, x, y)
			}
		}
	}
	walk(laid, 0, 0)
	if previous != nil {
		layoutReusePositions(input, positions, *previous)
	}
	ids := make([]string, len(input.Nodes))
	for index, node := range input.Nodes {
		ids[index] = node.ID
	}
	routed := layoutOrthogonalRoutes(input.Edges, positions, ids)
	outEdges := make([]LayoutRoutedEdge, len(input.Edges))
	for index, edge := range input.Edges {
		outEdges[index] = LayoutRoutedEdge{ID: edge.ID, Source: edge.Source, Target: edge.Target, Points: routed[edge.ID]}
	}
	return GraphLayout{Positions: positions, Edges: outEdges}
}

func layoutNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		number, _ := typed.Float64()
		return number
	default:
		return 0
	}
}

func layoutNumberDefault(value any, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return layoutNumber(value)
}

// PERF(port): elkjs has no sanctioned Go library. Layout shells out to node and elkjs from ApplicationRoot.
func layoutElk(graph map[string]any) map[string]any {
	payload, err := json.Marshal(graph)
	if err != nil {
		panic(err)
	}
	elkPath := filepath.Join(ApplicationRoot, "node_modules", "elkjs", "lib", "elk.bundled.js")
	script := `import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const ELK = require(process.env.GRAPH_ELK);
const elk = new ELK();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  const out = await elk.layout(JSON.parse(raw));
  process.stdout.write(JSON.stringify(out));
});`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Env = append(os.Environ(), "GRAPH_ELK="+elkPath)
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.Output()
	if err != nil {
		panic(fmt.Errorf("elkjs layout failed: %w", err))
	}
	var laid map[string]any
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.UseNumber()
	if err := decoder.Decode(&laid); err != nil {
		panic(err)
	}
	return laid
}

func layoutReusePositions(input LayoutInput, positions map[string]LayoutPosition, previous LayoutPrevious) {
	groups := input.Containers
	parents := layoutParentMap(input)
	oldParents := layoutParentMap(previous.Input)
	groupIDs := map[string]bool{}
	for _, group := range groups {
		groupIDs[group.ID] = true
	}
	oldGroups := map[string]bool{}
	for _, group := range previous.Input.Containers {
		oldGroups[group.ID] = true
	}
	stable := map[string]bool{}
	for id := range parents {
		current := id
		unchanged := true
		for {
			_, oldHas := oldParents[current]
			if !oldHas || parents[current] != oldParents[current] || groupIDs[current] != oldGroups[current] {
				unchanged = false
				break
			}
			next, ok := parents[current]
			if !ok || next == "" {
				break
			}
			current = next
		}
		if unchanged {
			if _, ok := previous.Layout.Positions[id]; ok {
				stable[id] = true
			}
		}
	}
	original := map[string]LayoutPosition{}
	for id, box := range positions {
		original[id] = box
	}
	for id := range parents {
		box := positions[id]
		if stable[id] {
			old := previous.Layout.Positions[id]
			if groupIDs[id] {
				positions[id] = old
			} else {
				box.X = old.X
				box.Y = old.Y
				positions[id] = box
			}
		} else {
			ancestor := parents[id]
			for ancestor != "" && !stable[ancestor] {
				ancestor = parents[ancestor]
			}
			if ancestor != "" {
				box.X += previous.Layout.Positions[ancestor].X - original[ancestor].X
				box.Y += previous.Layout.Positions[ancestor].Y - original[ancestor].Y
				positions[id] = box
			}
		}
	}
	children := func(parent string) []string {
		out := []string{}
		for id, value := range parents {
			if value == parent {
				out = append(out, id)
			}
		}
		return out
	}
	var shift func(string, float64, float64)
	shift = func(id string, dx, dy float64) {
		stack := []string{id}
		for len(stack) > 0 {
			next := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			box := positions[next]
			box.X += dx
			box.Y += dy
			positions[next] = box
			stack = append(stack, children(next)...)
		}
	}
	incoming := map[string]int{}
	outgoing := map[string]int{}
	for _, edge := range input.Edges {
		incoming[edge.Target]++
		outgoing[edge.Source]++
	}
	type footprint struct {
		id     string
		x, y   float64
		width  float64
		height float64
		top    float64
	}
	footprintOf := func(id string) footprint {
		box := positions[id]
		top := 0.0
		bottom := 0.0
		if !groupIDs[id] && incoming[id] > 0 {
			top = layoutGRID * float64(incoming[id]+1)
		}
		if !groupIDs[id] && outgoing[id] > 0 {
			bottom = layoutGRID * float64(outgoing[id]+1)
		}
		return footprint{id: id, x: box.X, y: box.Y - top, width: box.Width, height: box.Height + top + bottom, top: top}
	}
	unchanged := func(id string) bool {
		box, ok := positions[id]
		old, oldOK := previous.Layout.Positions[id]
		return stable[id] && ok && oldOK && box.X == old.X && box.Y == old.Y && box.Width == old.Width && box.Height == old.Height
	}
	settle := func(parent string) {
		occupied := []footprint{}
		ids := children(parent)
		sort.Slice(ids, func(i, j int) bool {
			priority := func(id string) int {
				value := 0
				if !stable[id] {
					value += 2
				}
				if !groupIDs[id] {
					value++
				}
				return value
			}
			return priority(ids[i]) < priority(ids[j])
		})
		for _, id := range ids {
			box := positions[id]
			before := box
			if parent != "" && !stable[id] {
				box.X = math.Max(box.X, positions[parent].X+32)
				box.Y = math.Max(box.Y, positions[parent].Y+32)
				positions[id] = box
			}
			for {
				area := footprintOf(id)
				collisions := []footprint{}
				for _, other := range occupied {
					if unchanged(id) && unchanged(other.id) {
						continue
					}
					if area.x < other.x+other.width+32 && area.x+area.width+32 > other.x && area.y < other.y+other.height+32 && area.y+area.height+32 > other.y {
						collisions = append(collisions, other)
					}
				}
				if len(collisions) == 0 {
					break
				}
				next := collisions[0].y + collisions[0].height + 32 + area.top
				for _, other := range collisions[1:] {
					if candidate := other.y + other.height + 32 + area.top; candidate > next {
						next = candidate
					}
				}
				box = positions[id]
				box.Y = layoutSnap(next)
				positions[id] = box
			}
			box = positions[id]
			dx := box.X - before.X
			dy := box.Y - before.Y
			box.X = before.X
			box.Y = before.Y
			positions[id] = box
			shift(id, dx, dy)
			occupied = append(occupied, footprintOf(id))
		}
		if parent != "" {
			box := positions[parent]
			width, height := box.Width, box.Height
			for _, id := range children(parent) {
				if unchanged(id) {
					continue
				}
				child := positions[id]
				if child.X+child.Width-box.X+32 > width {
					width = child.X + child.Width - box.X + 32
				}
				if child.Y+child.Height-box.Y+32 > height {
					height = child.Y + child.Height - box.Y + 32
				}
			}
			box.Width = math.Ceil(width/32) * 32
			box.Height = math.Ceil(height/layoutGRID) * layoutGRID
			positions[parent] = box
		}
	}
	depth := func(id string) int {
		count := 0
		current := parents[id]
		for current != "" {
			count++
			current = parents[current]
		}
		return count
	}
	ordered := append([]LayoutGroup{}, groups...)
	sort.Slice(ordered, func(i, j int) bool { return depth(ordered[i].ID) > depth(ordered[j].ID) })
	for _, group := range ordered {
		settle(group.ID)
	}
	settle("")
	boxes := []LayoutPosition{}
	for id := range parents {
		boxes = append(boxes, positions[id])
	}
	width, height := 160.0, 64.0
	for _, box := range boxes {
		if box.X+box.Width+32 > width {
			width = box.X + box.Width + 32
		}
		if box.Y+box.Height+32 > height {
			height = box.Y + box.Height + 32
		}
	}
	positions["root"] = LayoutPosition{X: 0, Y: 0, Width: math.Ceil(width/32) * 32, Height: math.Ceil(height/layoutGRID) * layoutGRID}
}

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
