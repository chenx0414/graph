package main

import (
	"encoding/json"
	"net/url"
	"strings"
)

const (
	fleetGraphCardW   = 220
	fleetGraphCardH   = 96
	fleetGraphColGap  = 90
	fleetGraphRowGap  = 28
	fleetGraphPad     = 28
	fleetGraphColsMax = 4
)

type fleetTopologyNode struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	Action          string `json:"action"`
	Status          string `json:"status"`
	Label           string `json:"label"`
	BoundDefinition string `json:"boundDefinition"`
	Model           string `json:"model"`
	X, Y, W, H      float32
	Agent           *fleetAgent
}

type fleetTopologyEdge struct {
	ID     string `json:"id"`
	From   string `json:"from"`
	To     string `json:"to"`
	Points [][2]float32
}

type fleetTopologyData struct {
	TaskID string
	Width  float32
	Height float32
	Nodes  []fleetTopologyNode
	Edges  []fleetTopologyEdge
	Levels map[string]int
}

type fleetGraphView struct {
	taskID  string
	title   string
	loading bool
	failed  string
	data    *fleetTopologyData
}

func fleetGraphPageID(taskID string) string {
	return "graph:" + taskID
}

func fleetGraphTaskIDOfPage(pageID string) string {
	return strings.TrimPrefix(pageID, "graph:")
}

func parseFleetTopology(payload []byte) (*fleetTopologyData, error) {
	var raw struct {
		TaskID string `json:"taskId"`
		Nodes  []struct {
			ID              string `json:"id"`
			Kind            string `json:"kind"`
			Action          string `json:"action"`
			Status          string `json:"status"`
			Label           string `json:"label"`
			BoundDefinition string `json:"boundDefinition"`
			Model           string `json:"model"`
		} `json:"nodes"`
		Edges []struct {
			ID   string `json:"id"`
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"edges"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, err
	}
	data := &fleetTopologyData{TaskID: raw.TaskID, Levels: map[string]int{}}
	for _, node := range raw.Nodes {
		data.Nodes = append(data.Nodes, fleetTopologyNode{
			ID: node.ID, Kind: node.Kind, Action: node.Action, Status: node.Status,
			Label: node.Label, BoundDefinition: node.BoundDefinition, Model: node.Model,
		})
	}
	for _, edge := range raw.Edges {
		data.Edges = append(data.Edges, fleetTopologyEdge{ID: edge.ID, From: edge.From, To: edge.To})
	}
	fleetTopologyLayout(data)
	return data, nil
}

func fleetTopologyLayout(data *fleetTopologyData) {
	if data == nil || len(data.Nodes) == 0 {
		data.Width, data.Height = 760, 420
		return
	}
	byID := map[string]int{}
	for index, node := range data.Nodes {
		byID[node.ID] = index
	}
	levels := fleetTopologyLevels(len(data.Nodes), byID, data.Edges)
	maxLevel := 0
	rows := map[int][]int{}
	for index := range data.Nodes {
		level := levels[index]
		rows[level] = append(rows[level], index)
		maxLevel = max(maxLevel, level)
	}
	columns := maxLevel + 1
	maxRows := 1
	for _, row := range rows {
		maxRows = max(maxRows, len(row))
	}
	width := float32(fleetGraphPad*2 + columns*fleetGraphCardW + (columns-1)*fleetGraphColGap)
	height := float32(fleetGraphPad*2 + maxRows*fleetGraphCardH + (maxRows-1)*fleetGraphRowGap)
	height = max(height, 420)
	for level := 0; level <= maxLevel; level++ {
		row := rows[level]
		layerHeight := float32(len(row)*fleetGraphCardH + max(0, len(row)-1)*fleetGraphRowGap)
		startY := (height - layerHeight) / 2
		for index, nodeIndex := range row {
			node := &data.Nodes[nodeIndex]
			node.W, node.H = fleetGraphCardW, fleetGraphCardH
			node.X = float32(fleetGraphPad + level*(fleetGraphCardW+fleetGraphColGap))
			node.Y = startY + float32(index*(fleetGraphCardH+fleetGraphRowGap))
			levels[nodeIndex] = level
		}
	}
	for nodeIndex, node := range data.Nodes {
		data.Levels[node.ID] = levels[nodeIndex]
	}
	for edgeIndex, edge := range data.Edges {
		from, fromOK := fleetTopologyNodeByID(data.Nodes, edge.From)
		to, toOK := fleetTopologyNodeByID(data.Nodes, edge.To)
		if !fromOK || !toOK {
			continue
		}
		data.Edges[edgeIndex].Points = fleetRingEdgePoints(
			[2]float32{from.X + from.W, from.Y + from.H/2},
			[2]float32{to.X, to.Y + to.H/2},
		)
	}
	data.Width, data.Height = width, height
}

func fleetTopologyLevels(count int, byID map[string]int, edges []fleetTopologyEdge) []int {
	levels := make([]int, count)
	if len(edges) == 0 {
		rows := (count + fleetGraphColsMax - 1) / fleetGraphColsMax
		for index := range levels {
			levels[index] = index / rows
		}
		return levels
	}
	preds := make([][]int, count)
	for _, edge := range edges {
		from, fromOK := byID[edge.From]
		to, toOK := byID[edge.To]
		if !fromOK || !toOK || edge.From == edge.To {
			continue
		}
		preds[to] = append(preds[to], from)
	}
	for index := range levels {
		levels[index] = -1
	}
	state := make([]int, count)
	var visit func(int) int
	visit = func(index int) int {
		if state[index] == 2 {
			return levels[index]
		}
		state[index] = 1
		best := 0
		for _, predecessor := range preds[index] {
			if state[predecessor] == 1 {
				continue
			}
			if candidate := visit(predecessor) + 1; candidate > best {
				best = candidate
			}
		}
		levels[index] = best
		state[index] = 2
		return best
	}
	for index := range levels {
		if state[index] == 0 {
			visit(index)
		}
	}
	return levels
}

func nodeIDAt(byID map[string]int, index int) string {
	for id, at := range byID {
		if at == index {
			return id
		}
	}
	return ""
}

func fleetTopologyNodeByID(nodes []fleetTopologyNode, id string) (fleetTopologyNode, bool) {
	for _, node := range nodes {
		if node.ID == id {
			return node, true
		}
	}
	return fleetTopologyNode{}, false
}

func (s *shellState) openFleetGraphPage(unit fleetGraphUnit) error {
	taskID := unit.TaskID
	if taskID == "" {
		return nil
	}
	id := fleetGraphPageID(taskID)
	for index := range s.board.pages {
		if s.board.pages[index].ID == id {
			s.selectBoardPage(index)
			return nil
		}
	}
	title := strings.TrimSpace(unit.Title)
	if title == "" {
		title = "Graph"
	}
	s.board.pages = append(s.board.pages, boardPage{
		ID: id, Title: title, Kind: "fleet-graph",
		Panels: []boardPanel{{ID: "graph-dag", Kind: "graph-dag"}},
		Layout: boardNode{Kind: "panel", PanelID: "graph-dag"},
	})
	s.board.active = len(s.board.pages) - 1
	s.ensureBoardPageData()
	s.saveBoard()
	s.frame()
	return nil
}

func (s *shellState) ensureFleetGraph() {
	page := s.boardPage()
	taskID := fleetGraphTaskIDOfPage(page.ID)
	if taskID == "" {
		return
	}
	if s.graph.taskID == taskID && (s.graph.loading || s.graph.data != nil || s.graph.failed != "") {
		return
	}
	s.ensureFleet()
	s.graph = fleetGraphView{taskID: taskID, title: page.Title, loading: true}
	s.graphRetry()
}

func (s *shellState) graphRetry() {
	state := s.graph
	if state.taskID == "" {
		return
	}
	state.loading = true
	state.failed = ""
	s.graph = state
	taskID := state.taskID
	go func() {
		payload, err := s.api.get("/api/tasks/" + url.PathEscape(taskID) + "/graph/topology")
		if s.graph.taskID != taskID {
			return
		}
		state := s.graph
		if err != nil {
			state.loading = false
			state.failed = "读不到 Graph 拓扑：" + err.Error()
			s.graph = state
			s.frame()
			return
		}
		data, err := parseFleetTopology(payload)
		if err != nil {
			state.loading = false
			state.failed = "Graph 拓扑不是预期的 JSON"
			s.graph = state
			s.frame()
			return
		}
		state.data = data
		state.loading = false
		s.graph = state
		s.frame()
	}()
}
