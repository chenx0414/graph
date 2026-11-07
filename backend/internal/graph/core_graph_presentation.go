package graph

import (
	"strings"

	"math"
)

type GraphNodeVisualKindValue string

const (
	GraphNodeVisualAgent   GraphNodeVisualKindValue = "agent"
	GraphNodeVisualTool    GraphNodeVisualKindValue = "tool"
	GraphNodeVisualHuman   GraphNodeVisualKindValue = "human"
	GraphNodeVisualGate    GraphNodeVisualKindValue = "gate"
	GraphNodeVisualRoute   GraphNodeVisualKindValue = "route"
	GraphNodeVisualJoin    GraphNodeVisualKindValue = "join"
	GraphNodeVisualProgram GraphNodeVisualKindValue = "program"
)

type GraphNodeLike struct {
	Id     string
	Kind   string
	Action string
}

type GraphNodeBox struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

func GraphNodeVisualKind(node GraphNodeLike) GraphNodeVisualKindValue {
	if node.Kind == "agent" {
		return GraphNodeVisualAgent
	}
	switch node.Action {
	case "graph.human_check":
		return GraphNodeVisualHuman
	case "graph.verify":
		return GraphNodeVisualGate
	case "route":
		return GraphNodeVisualRoute
	case "join":
		return GraphNodeVisualJoin
	case "graph.command":
		return GraphNodeVisualTool
	}
	if node.Kind == "program" {
		return GraphNodeVisualTool
	}
	return GraphNodeVisualProgram
}

func GraphNodeSuffix(node GraphNodeLike) string {
	if GraphNodeVisualKind(node) == GraphNodeVisualHuman {
		return "human check"
	}
	if node.Kind == "agent" {
		return "agent"
	}
	switch node.Action {
	case "graph.verify":
		return "gate"
	case "graph.command":
		return "tool"
	case "route":
		return "route"
	case "join":
		return "join"
	}
	if node.Kind == "program" {
		return "tool"
	}
	return node.Kind
}

func GraphNodeLabel(node GraphNodeLike) string {
	suffix := GraphNodeSuffix(node)
	prefix := strings.ToLower(node.Id)
	suffixLower := strings.ToLower(suffix)
	if suffixLower == prefix || strings.HasPrefix(suffixLower, prefix+" ") {
		return suffix
	}
	return node.Id + " " + suffix
}

func graphPresentationTextWidth(value string) int {
	sum := 0
	for _, character := range value {
		if character > 255 {
			sum += 13
		} else {
			sum += 7
		}
	}
	return sum
}

func GraphNodeSize(node GraphNodeLike) GraphNodeBox {
	estimated := graphPresentationTextWidth(GraphNodeLabel(node)) + 74
	width := int(math.Min(384, math.Max(160, math.Ceil(float64(estimated)/32)*32)))
	height := 64
	if estimated > 384 {
		height = 96
	}
	return GraphNodeBox{Width: width, Height: height}
}
