package graph

import (
	"math"
)

const layoutGRID = 16

type LayoutNode struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Action    string `json:"action,omitempty"`
	Container string `json:"container,omitempty"`
}

type LayoutGroup struct {
	ID     string `json:"id"`
	Parent string `json:"parent,omitempty"`
}

type LayoutEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

type LayoutInput struct {
	Nodes      []LayoutNode  `json:"nodes"`
	Containers []LayoutGroup `json:"containers,omitempty"`
	Edges      []LayoutEdge  `json:"edges"`
}

type LayoutPosition struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type LayoutPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type LayoutRoutedEdge struct {
	ID     string        `json:"id"`
	Source string        `json:"source"`
	Target string        `json:"target"`
	Points []LayoutPoint `json:"points,omitempty"`
}

type GraphLayout struct {
	Positions map[string]LayoutPosition `json:"positions"`
	Edges     []LayoutRoutedEdge        `json:"edges"`
}

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

func layoutPresentationNode(node LayoutNode) GraphNodeLike {
	return GraphNodeLike{Id: node.ID, Kind: node.Kind, Action: node.Action}
}

func layoutNodeSize(node LayoutNode) (float64, float64) {
	box := GraphNodeSize(layoutPresentationNode(node))
	return float64(box.Width), float64(box.Height)
}
