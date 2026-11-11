package main

import (
	"encoding/json"
	"math"

	"github.com/egoist/mygo/ui"
)

var (
	graphNodeLabelColor  = ui.Hex("#1C2436")
	graphStatusRunning   = ui.Hex("#2F5BFF")
	graphStatusSucceeded = ui.Hex("#22A06B")
	graphStatusFailed    = ui.Hex("#D64545")
	graphStatusIdle      = ui.Hex("#9AA3B5")
	graphNodeSurface     = ui.Hex("#FFFFFF")
	graphNodeBorder      = ui.Hex("#E3E7F1")
	graphEdgeColor       = ui.Hex("#C6CEE2")
)

type taskGraph struct {
	nodes []taskGraphNode
	edges []taskGraphEdge
}

type taskGraphNode struct {
	id     string
	label  string
	kind   string
	status string
	x      float32
	y      float32
	w      float32
	h      float32
}

type taskGraphEdge struct {
	source string
	target string
	points [][2]float32
}

type taskGraphPayload struct {
	Nodes []struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		Label  string `json:"label"`
		Status string `json:"status"`
	} `json:"nodes"`
	Layout struct {
		Positions map[string]struct {
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
		} `json:"positions"`
		Edges []struct {
			Source string `json:"source"`
			Target string `json:"target"`
			Points []struct {
				X float64 `json:"x"`
				Y float64 `json:"y"`
			} `json:"points"`
		} `json:"edges"`
	} `json:"layout"`
}

func parseTaskGraph(payload []byte) (taskGraph, error) {
	var shaped taskGraphPayload
	if err := json.Unmarshal(payload, &shaped); err != nil {
		return taskGraph{}, err
	}
	graph := taskGraph{}
	for index, node := range shaped.Nodes {
		label := node.Label
		if label == "" {
			label = node.ID
		}
		status := node.Status
		if status == "" {
			status = "idle"
		}
		place := shaped.Layout.Positions[node.ID]
		x, y := float32(place.X), float32(place.Y)
		w, h := float32(place.Width), float32(place.Height)
		if w <= 0 || h <= 0 {
			x, y = float32(index%3)*240, float32(index/3)*140
			w, h = 180, 56
		}
		graph.nodes = append(graph.nodes, taskGraphNode{
			id: node.ID, label: label, kind: node.Kind, status: status, x: x, y: y, w: w, h: h,
		})
	}
	for _, edge := range shaped.Layout.Edges {
		routed := taskGraphEdge{source: edge.Source, target: edge.Target}
		for _, point := range edge.Points {
			routed.points = append(routed.points, [2]float32{float32(point.X), float32(point.Y)})
		}
		graph.edges = append(graph.edges, routed)
	}
	return graph, nil
}

func graphStatusColor(status string) ui.Color {
	switch status {
	case "running", "executing", "active":
		return graphStatusRunning
	case "succeeded", "completed", "done":
		return graphStatusSucceeded
	case "failed", "error":
		return graphStatusFailed
	}
	return graphStatusIdle
}

func (c *chatState) loadGraph(taskID string) {
	payload, err := c.api.get("/api/tasks/" + taskID + "/graph")
	if err != nil {
		c.graphError = "读不到图谱：" + err.Error()
		c.graphLoading = false
		c.frame()
		return
	}
	graph, err := parseTaskGraph(payload)
	if err != nil {
		c.graphError = "图谱不是预期的 JSON：" + err.Error()
		c.graphLoading = false
		c.frame()
		return
	}
	c.graph = graph
	c.graphTaskID = taskID
	c.graphError = ""
	c.graphLoading = false
	c.frame()
}

func drawBoardGraph(p *ui.Painter, area ui.Rect, graph taskGraph) {
	if len(graph.nodes) == 0 {
		return
	}
	p.Clip(area, 0, func() {
		drawBoardGraphIn(p, area, graph)
	})
}

func drawBoardGraphIn(p *ui.Painter, area ui.Rect, graph taskGraph) {
	minX, minY := float32(math.MaxFloat32), float32(math.MaxFloat32)
	maxX, maxY := float32(-math.MaxFloat32), float32(-math.MaxFloat32)
	for _, node := range graph.nodes {
		minX = min(minX, node.x)
		minY = min(minY, node.y)
		maxX = max(maxX, node.x+node.w)
		maxY = max(maxY, node.y+node.h)
	}
	spanX, spanY := maxX-minX, maxY-minY
	padding := float32(28)
	scale := min((area.W-2*padding)/max(spanX, 1), (area.H-2*padding)/max(spanY, 1))
	scale = min(scale, 1.15)
	scale = max(scale, 0.45)
	originX := area.X + padding + (area.W-2*padding-spanX*scale)/2 - minX*scale
	originY := area.Y + padding + (area.H-2*padding-spanY*scale)/2 - minY*scale
	at := func(x, y float32) (float32, float32) {
		return originX + x*scale, originY + y*scale
	}
	for _, edge := range graph.edges {
		points := make([][2]float32, 0, len(edge.points))
		for _, point := range edge.points {
			x, y := at(point[0], point[1])
			points = append(points, [2]float32{x, y})
		}
		if len(points) >= 2 {
			p.StrokePolyline(points, 1.5, graphEdgeColor)
		}
	}
	for _, node := range graph.nodes {
		x, y := at(node.x, node.y)
		rect := ui.Rect{X: x, Y: y, W: node.w * scale, H: node.h * scale}
		radius := 9 * scale
		p.Fill(rect, graphNodeSurface, radius)
		p.Stroke(rect, graphNodeBorder, radius, 1)
		dot := 8 * scale
		p.Fill(ui.Rect{X: x + 10*scale, Y: y + 10*scale, W: dot, H: dot}, graphStatusColor(node.status), dot/2)
		p.Text(x+24*scale, y+9*scale, node.label, 12*scale, ui.Hex("#1C2436"))
	}
}
