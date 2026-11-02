package graph

import (
	"math"
	"strconv"
)

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
		size := GraphNodeSize(GraphNodeLike{Id: node.ID, Kind: node.Kind, Action: node.Action})
		width, height := float64(size.Width), float64(size.Height)
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
	routed := OrthogonalRoutes(input.Edges, positions, ids)
	outEdges := make([]LayoutRoutedEdge, len(input.Edges))
	for index, edge := range input.Edges {
		outEdges[index] = LayoutRoutedEdge{ID: edge.ID, Source: edge.Source, Target: edge.Target, Points: routed[edge.ID]}
	}
	return GraphLayout{Positions: positions, Edges: outEdges}
}
