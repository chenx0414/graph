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
	netRingWidth   = 340
	netRingHeight  = 300
	netRingCenterW = 112
	netRingCenterH = 48
	netRingChipW   = 104
	netRingChipH   = 34
	netRingRx      = 124
	netRingRy      = 94
	netRingSlots   = 6
)

type netPanelState struct {
	key        string
	generation int
	loading    bool
	failed     string
	data       *fleetTopologyData
	scroll     ui.ScrollState
}

func (s *shellState) panelChatNetwork(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	scope := s.chatScope()
	if scope.key() == "" {
		s.boardNote(ctx, "先打开一个对话，这里会显示它所在的编队。")
		return
	}
	if scope.Kind == "node" {
		s.networkGraphPanel(ctx, scope)
		return
	}
	agent, data := s.chatAgent()
	if agent == nil || data == nil {
		text := "正在读取编队…"
		if s.fleet.failed != "" {
			text = s.fleet.failed
		}
		if s.fleet.data == nil {
			kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
			if !s.fleet.loading && s.fleet.failed == "" {
				s.ensureFleet()
			}
			return
		}
		s.boardNote(ctx, "这个对话还没有登记为 Agent。")
		return
	}
	if agent.Kind == "global" {
		s.networkThreadRing(ctx, agent, data)
		return
	}
	s.networkGraphRing(ctx, *agent, data)
}

func (s *shellState) networkCanvas(ctx *ui.Context, width, height float32, edges [][2][2]float32, body func(*ui.Context)) {
	world := ui.Box(ctx).Width(width).Height(height)
	world.Draw(func(p *ui.Painter, r ui.Rect) {
		t := gwtheme.Of(ctx)
		for _, edge := range edges {
			points := fleetCurvePoints(edge[0], edge[1])
			shifted := make([][2]float32, len(points))
			for index, point := range points {
				shifted[index] = [2]float32{r.X + point[0], r.Y + point[1]}
			}
			p.StrokePolyline(shifted, float32(gwtheme.Stroke), t.Border.Alpha(0.5))
		}
	})
	world.Children(func() { body(ctx) })
}

func fleetCurvePoints(from, to [2]float32) [][2]float32 {
	points := make([][2]float32, 0, 17)
	for index := 0; index <= 16; index++ {
		ratio := float32(index) / 16
		x := from[0] + (to[0]-from[0])*ratio
		y := from[1] + (to[1]-from[1])*ratio
		curve := float32(math.Sin(float64(ratio)*math.Pi)) * (to[1] - from[1]) * -0.12
		points = append(points, [2]float32{x, y + curve})
	}
	return points
}

func (s *shellState) networkCaption(ctx *ui.Context, text string) {
	t := gwtheme.Of(ctx)
	kit.Text(ctx, text, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
}

func (s *shellState) networkCenter(ctx *ui.Context, title, meta string, accent ui.Color, onOpen func()) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).Clip().Padding(th.Space(0.75), th.Space(1.25)).Gap(th.Space(0.25)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, accent.Alpha(0.55)).Focusable()
	card.Width(netRingCenterW).Height(netRingCenterH)
	card.Label("网络中心 " + title)
	card.OnClick(onOpen)
	card.Children(func() {
		kit.Text(ctx, title, t.Text.Sm).FontWeight(650).TextColor(t.Foreground).SingleLine().Ellipsis("…")
		kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	})
	card.Absolute().Left(float32(netRingWidth)/2 - netRingCenterW/2).Top(float32(netRingHeight)/2 - netRingCenterH/2)
}

func (s *shellState) networkChip(ctx *ui.Context, id, title, meta string, x, y float32, accent ui.Color, onOpen func()) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).Clip().Padding(th.Space(0.5), th.Space(1)).Gap(0).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, accent.Alpha(0.45)).Focusable()
	card.Width(netRingChipW).Height(netRingChipH)
	card.Label("网络节点 " + title)
	card.Tooltip(title + " · " + meta)
	card.OnClick(onOpen)
	s.fleetHoverCard(card, id, accent, t)
	card.Children(func() {
		kit.Text(ctx, title, t.Text.Xs).FontWeight(650).TextColor(t.Foreground).SingleLine().Ellipsis("…")
		kit.Text(ctx, meta, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
	})
	card.Absolute().Left(x).Top(y)
	return card
}

func netRingPosition(index, total int) (float32, float32, [2]float32, [2]float32) {
	angle := -math.Pi/2 + 2*math.Pi*float64(index)/float64(max(1, total))
	x := float32(netRingWidth)/2 + float32(math.Cos(angle))*netRingRx
	y := float32(netRingHeight)/2 + float32(math.Sin(angle))*netRingRy
	left, top := x-netRingChipW/2, y-netRingChipH/2
	return left, top, [2]float32{x, y}, [2]float32{float32(netRingWidth) / 2, float32(netRingHeight) / 2}
}

func (s *shellState) networkThreadRing(ctx *ui.Context, main *fleetAgent, data *fleetSnapshot) {
	groups := fleetGroups(data)
	threads := make([]fleetAgent, 0, len(groups))
	for _, group := range groups {
		if group.Orphan {
			continue
		}
		threads = append(threads, group.Project)
	}
	total := len(threads)
	s.networkCaption(ctx, formatFleetCount(total)+" 个 Thread Agent · Main 中心")
	hidden := 0
	if len(threads) > netRingSlots-1 {
		hidden = total - (netRingSlots - 1)
		threads = threads[:netRingSlots-1]
	}
	slots := len(threads)
	if hidden > 0 {
		slots++
	}
	edges := make([][2][2]float32, 0, slots)
	for index := 0; index < slots; index++ {
		_, _, center, hub := netRingPosition(index, slots)
		edges = append(edges, [2][2]float32{hub, center})
	}
	ui.ScrollBoth(ctx).Fill().TrackScroll(&s.fleet.netScroll).Children(func() {
		s.networkCanvas(ctx, netRingWidth, netRingHeight, edges, func(ctx *ui.Context) {
			accent := fleetAccents()[0]
			s.networkCenter(ctx, fleetAgentLabel(*main), fleetStatusLabel(main.Status)+" · "+formatFleetCount(total)+" 个线程", accent, func() {
				go s.openFleetAgentChat(*main)
			})
			for index, thread := range threads {
				left, top, _, _ := netRingPosition(index, slots)
				member := thread
				chipAccent := fleetAccents()[(index+1)%len(fleetAccents())]
				s.networkChip(ctx, member.ID, fleetAgentLabel(member), fleetStatusLabel(member.Status), left, top, chipAccent, func() {
					go s.openFleetAgentChat(member)
				})
			}
			if hidden > 0 {
				left, top, _, _ := netRingPosition(slots-1, slots)
				s.networkChip(ctx, "hidden-threads", "还有 "+formatFleetCount(hidden), "个 Thread Agent", left, top, fleetAccents()[1], func() {})
			}
		})
	})
}

func (s *shellState) networkGraphRing(ctx *ui.Context, thread fleetAgent, data *fleetSnapshot) {
	units := make([]fleetGraphUnit, 0, 8)
	for _, unit := range fleetGraphUnits(data) {
		if unit.ThreadID == thread.ID {
			units = append(units, unit)
		}
	}
	total := len(units)
	s.networkCaption(ctx, fleetAgentLabel(thread)+" · "+formatFleetCount(total)+" 个 Graph")
	if total == 0 {
		s.boardNote(ctx, "这个线程还没有可展示的 Graph。")
		return
	}
	hidden := 0
	if len(units) > netRingSlots-1 {
		hidden = total - (netRingSlots - 1)
		units = units[:netRingSlots-1]
	}
	slots := len(units)
	if hidden > 0 {
		slots++
	}
	edges := make([][2][2]float32, 0, slots)
	for index := 0; index < slots; index++ {
		_, _, center, hub := netRingPosition(index, slots)
		edges = append(edges, [2][2]float32{hub, center})
	}
	ui.ScrollBoth(ctx).Fill().TrackScroll(&s.fleet.netScroll).Children(func() {
		s.networkCanvas(ctx, netRingWidth, netRingHeight, edges, func(ctx *ui.Context) {
			accent := fleetAccents()[1]
			s.networkCenter(ctx, fleetAgentLabel(thread), "Thread Agent · "+formatFleetCount(total)+" 个 Graph", accent, func() {
				go s.openFleetAgentChat(thread)
			})
			for index, unit := range units {
				left, top, _, _ := netRingPosition(index, slots)
				selected := unit
				meta := formatFleetCount(unit.NodeCount) + " 节点 · " + fleetStatusLabel(unit.Status)
				s.networkChip(ctx, unit.TaskID, unit.Title, meta, left, top, accent, func() {
					_ = s.openFleetGraphPage(selected)
				})
			}
			if hidden > 0 {
				left, top, _, _ := netRingPosition(slots-1, slots)
				s.networkChip(ctx, "hidden-graphs", "还有 "+formatFleetCount(hidden), "个 Graph", left, top, accent, func() {})
			}
		})
	})
}

func (s *shellState) networkGraphPanel(ctx *ui.Context, scope chatScope) {
	t := gwtheme.Of(ctx)
	state := &s.boardNet
	s.ensureNetGraph(scope)
	if state.data == nil {
		text := "正在读取 Graph…"
		if state.failed != "" {
			text = state.failed
		}
		kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
		return
	}
	s.networkCaption(ctx, "Graph · "+strconv.Itoa(len(state.data.Nodes))+" 节点 · "+strconv.Itoa(len(state.data.Edges))+" 边")
	ui.ScrollBoth(ctx).Fill().TrackScroll(&state.scroll).Children(func() {
		s.fleetGraphCanvas(ctx, state.data)
	})
}

func (s *shellState) ensureNetGraph(scope chatScope) {
	state := &s.boardNet
	key := scope.key()
	if key == "" {
		return
	}
	if state.key != key {
		state.key = key
		state.data = nil
		state.failed = ""
		state.loading = false
	}
	if state.loading || state.data != nil {
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
			s.boardNet.data = data
			s.boardNet.failed = ""
		})
	}()
}

func (s *shellState) refreshNetGraph(scope chatScope) {
	state := &s.boardNet
	if state.key != scope.key() || state.loading || state.data == nil {
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
			s.boardNet.data = data
		})
	}()
}
