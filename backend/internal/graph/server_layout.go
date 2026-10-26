package graph

import (
	"math"
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
