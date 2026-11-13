package main

import (
	"math"
	"net/url"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

const (
	netThreadWorldW = 760
	netThreadWorldH = 560
	netThreadRx     = 250
	netThreadRy     = 170
)

type netScene struct {
	mode      string
	width     float32
	height    float32
	nodes     []fleetRingNode
	polylines [][][2]float32
	topology  *fleetTopologyData
}

type netPanelState struct {
	key        string
	page       string
	generation int
	loading    bool
	failed     string
	topology   *fleetTopologyData
	scene      netScene
	view       infiniteCanvas
}

func (scene netScene) hit(x, y float32) bool {
	for _, node := range scene.nodes {
		if x >= node.X && x <= node.X+node.W && y >= node.Y && y <= node.Y+node.H {
			return true
		}
	}
	return false
}

func (s *shellState) panelScope() string {
	page := s.boardPage()
	if page == nil {
		return ""
	}
	for index := range page.Panels {
		if page.Panels[index].Kind == "agent-network" {
			return page.Panels[index].Scope
		}
	}
	return page.Scope
}

func (s *shellState) panelChatNetwork(ctx *ui.Context, scope string) {
	t := gwtheme.Of(ctx)
	scene, note := s.networkScene(ctx, scope)
	if note != "" {
		kit.Text(ctx, note, t.Text.Sm).TextColor(t.Muted)
		return
	}
	if len(scene.nodes) == 0 {
		if scope == "fleet" {
			s.boardNote(ctx, "编队还没有可展示的 Agent。")
			return
		}
		s.boardNote(ctx, "这里还没有可展示的内容。")
		return
	}
	state := &s.boardNet
	if page := s.boardPage(); page != nil && state.page != page.ID {
		state.page = page.ID
		state.view.fit = false
	}
	key := networkSceneKey(scope)
	if state.key != key || !sameNetScene(state.scene, scene) {
		if state.key != key {
			state.view = infiniteCanvas{}
		}
		state.key = key
		state.scene = scene
	}
	s.networkCaption(ctx, scene, scope)
	s.infiniteView(ctx, &state.view, scene.width, scene.height, scene.polylines, scene.hit, func(ctx *ui.Context, view *infiniteCanvas) {
		s.networkCards(ctx, scene, view)
	})
}

func sameNetScene(left, right netScene) bool {
	if left.mode != right.mode || left.width != right.width || left.height != right.height || len(left.nodes) != len(right.nodes) {
		return false
	}
	if left.topology != right.topology {
		return false
	}
	for index := range left.nodes {
		if left.nodes[index].ID != right.nodes[index].ID || left.nodes[index].X != right.nodes[index].X || left.nodes[index].Y != right.nodes[index].Y {
			return false
		}
	}
	return true
}

func (s *shellState) networkCaption(ctx *ui.Context, scene netScene, scope string) {
	t := gwtheme.Of(ctx)
	label := scene.mode
	switch scene.mode {
	case "fleet":
		if scope == "fleet" && s.fleet.data != nil {
			label = formatFleetCount(len(s.fleet.data.Agents)) + " 个 Agent · " + formatFleetCount(s.fleet.data.Stats.Running) + " 运行中 · Main 中心 · Thread 环 · Graph 环"
		} else {
			label = "编队 · Main 中心 · Thread 环"
		}
	case "thread":
		label = "线程 · Graph 环"
	case "graph":
		label = "Graph · " + strconv.Itoa(len(scene.topology.Nodes)) + " 节点"
	}
	kit.Text(ctx, label+" · 拖拽平移 · 滚轮缩放", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
}

func (s *shellState) networkCards(ctx *ui.Context, scene netScene, view *infiniteCanvas) {
	switch scene.mode {
	case "graph":
		for index := range scene.topology.Nodes {
			node := scene.topology.Nodes[index]
			card := s.fleetTopologyCard(ctx, scene.topology, node)
			card.Width(node.W * view.zoom).Height(node.H * view.zoom)
			card.Absolute().Left(view.x + node.X*view.zoom).Top(view.y + node.Y*view.zoom)
		}
	default:
		for _, node := range scene.nodes {
			positioned := node
			positioned.W = node.W * view.zoom
			positioned.H = node.H * view.zoom
			card := s.fleetRingElement(ctx, positioned)
			card.Absolute().Left(view.x + node.X*view.zoom).Top(view.y + node.Y*view.zoom)
		}
	}
}

func networkSceneKey(scope string) string {
	if scope == "fleet" {
		return "fleet"
	}
	return "chat"
}

func (s *shellState) networkScene(ctx *ui.Context, scope string) (netScene, string) {
	if scope == "fleet" {
		data := s.fleetData(ctx)
		if data == nil {
			return netScene{}, ""
		}
		s.fleetNetworkModels(data)
		return fleetNetScene(data), ""
	}
	chat := s.chatScope()
	if chat.key() == "" {
		return netScene{}, "先打开一个对话，这里会显示它所在的编队。"
	}
	scene, note := s.networkSceneForChat(chat)
	return scene, note
}

func (s *shellState) networkSceneForChat(scope chatScope) (netScene, string) {
	if scope.Kind == "node" {
		state := &s.boardNet
		s.ensureNetGraph(scope)
		if state.topology == nil {
			note := "正在读取 Graph…"
			if state.failed != "" {
				note = state.failed
			}
			return netScene{}, note
		}
		return graphNetScene(state.topology), ""
	}
	agent, data := s.chatAgent()
	if agent == nil || data == nil {
		note := "正在读取编队…"
		if s.fleet.failed != "" {
			note = s.fleet.failed
		}
		if s.fleet.data == nil {
			if !s.fleet.loading && s.fleet.failed == "" {
				s.ensureFleet()
			}
			return netScene{}, note
		}
		return netScene{}, "这个对话还没有登记为 Agent。"
	}
	if agent.Kind == "global" {
		return fleetNetScene(data), ""
	}
	return threadNetScene(*agent, data), ""
}

func fleetNetScene(data *fleetSnapshot) netScene {
	ring := fleetRingLayout(data)
	if len(ring.Nodes) == 0 {
		return netScene{}
	}
	polylines := make([][][2]float32, 0, len(ring.Edges))
	for _, edge := range ring.Edges {
		polylines = append(polylines, edge.Points)
	}
	return netScene{mode: "fleet", width: ring.Width, height: ring.Height, nodes: ring.Nodes, polylines: polylines}
}

func threadNetScene(thread fleetAgent, data *fleetSnapshot) netScene {
	units := make([]fleetGraphUnit, 0, 8)
	for _, unit := range fleetGraphUnits(data) {
		if unit.ThreadID == thread.ID {
			units = append(units, unit)
		}
	}
	scene := netScene{mode: "thread", width: netThreadWorldW, height: netThreadWorldH}
	center := fleetRingNode{
		Kind: "thread", ID: thread.ID, Agent: thread,
		W: fleetRingThreadW, H: fleetRingThreadH,
		X: netThreadWorldW/2 - fleetRingThreadW/2, Y: netThreadWorldH/2 - fleetRingThreadH/2,
	}
	scene.nodes = append(scene.nodes, center)
	if len(units) == 0 {
		return scene
	}
	hub := [2]float32{netThreadWorldW / 2, netThreadWorldH / 2}
	for index, unit := range units {
		angle := -math.Pi/2 + 2*math.Pi*float64(index)/float64(len(units))
		x := hub[0] + netThreadRx*float32(math.Cos(angle))
		y := hub[1] + netThreadRy*float32(math.Sin(angle))
		node := fleetRingNode{
			Kind: "graph-unit", ID: "graph:" + unit.TaskID, Unit: unit,
			W: fleetRingGraphW, H: fleetRingGraphH,
			X: x - fleetRingGraphW/2, Y: y - fleetRingGraphH/2,
		}
		scene.nodes = append(scene.nodes, node)
		scene.polylines = append(scene.polylines, [][2]float32{hub, [2]float32{x, y}})
	}
	return scene
}

func graphNetScene(data *fleetTopologyData) netScene {
	if data == nil {
		return netScene{}
	}
	nodes := make([]fleetRingNode, 0, len(data.Nodes))
	for _, node := range data.Nodes {
		nodes = append(nodes, fleetRingNode{Kind: "graph-node", ID: node.ID, X: node.X, Y: node.Y, W: node.W, H: node.H})
	}
	polylines := make([][][2]float32, 0, len(data.Edges))
	for _, edge := range data.Edges {
		polylines = append(polylines, edge.Points)
	}
	return netScene{mode: "graph", width: data.Width, height: data.Height, nodes: nodes, polylines: polylines, topology: data}
}

func (s *shellState) ensureNetGraph(scope chatScope) {
	state := &s.boardNet
	key := scope.key()
	if state.key != key {
		state.key = key
		state.topology = nil
		state.failed = ""
		state.loading = false
	}
	if state.loading || state.topology != nil {
		return
	}
	state.loading = true
	state.generation++
	generation := state.generation
	taskID := scope.TaskID
	api := s.api
	go func() {
		payload, err := api.get("/api/tasks/" + url.PathEscape(taskID) + "/graph/topology")
		var data *fleetTopologyData
		if err == nil {
			data, err = parseFleetTopology(payload)
			if err == nil {
				fleetTopologyLayout(data)
			}
		}
		s.updates.post(s.window, func() {
			if s.boardNet.key != key || s.boardNet.generation != generation || s.api != api {
				return
			}
			s.boardNet.loading = false
			if err != nil {
				s.boardNet.failed = "读不到 Graph 拓扑：" + err.Error()
				return
			}
			s.boardNet.topology = data
			s.boardNet.failed = ""
		})
	}()
}

func (s *shellState) refreshNetGraph(scope chatScope) {
	state := &s.boardNet
	if state.key != scope.key() || state.loading || state.topology == nil {
		return
	}
	state.generation++
	generation := state.generation
	taskID := scope.TaskID
	api := s.api
	go func() {
		payload, err := api.get("/api/tasks/" + url.PathEscape(taskID) + "/graph/topology")
		var data *fleetTopologyData
		if err == nil {
			data, err = parseFleetTopology(payload)
			if err == nil {
				fleetTopologyLayout(data)
			}
		}
		s.updates.post(s.window, func() {
			if err != nil || s.boardNet.key != scope.key() || s.boardNet.generation != generation || s.api != api {
				return
			}
			s.boardNet.topology = data
		})
	}()
}
