package main

import (
	"encoding/json"
	"net/url"
	"reflect"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

const (
	fleetDetailLimit      = 40
	fleetDetailTasksShown = 8
	fleetDetailEventShown = 8
	fleetDetailArtifacts  = 8
	fleetDetailText       = 200
)

func parseFleetHistory(payload []byte) ([]fleetActivity, error) {
	var body struct {
		Messages []struct {
			ID        string `json:"id"`
			Role      string `json:"role"`
			Kind      string `json:"kind"`
			Text      string `json:"text"`
			State     string `json:"state"`
			CreatedAt int64  `json:"createdAt"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, err
	}
	activities := make([]fleetActivity, 0, len(body.Messages))
	for _, message := range body.Messages {
		activities = append(activities, fleetActivity{
			ID: message.ID, At: message.CreatedAt, Role: message.Role, Kind: message.Kind, Text: message.Text, State: message.State,
		})
	}
	return activities, nil
}

func parseFleetNodeRun(payload []byte) ([]fleetActivity, error) {
	var body struct {
		Entries []struct {
			ID        string `json:"id"`
			Role      string `json:"role"`
			Kind      string `json:"kind"`
			Text      string `json:"text"`
			CreatedAt int64  `json:"createdAt"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, err
	}
	activities := make([]fleetActivity, 0, len(body.Entries))
	for _, entry := range body.Entries {
		activities = append(activities, fleetActivity{
			ID: entry.ID, At: entry.CreatedAt, Role: entry.Role, Kind: entry.Kind, Text: entry.Text,
		})
	}
	return activities, nil
}

func fleetDetailPath(agent fleetAgent) (string, bool) {
	switch {
	case agent.Kind == "node" && agent.TaskID != "" && agent.NodeID != "":
		return "/api/tasks/" + url.PathEscape(agent.TaskID) + "/nodes/" + url.PathEscape(agent.NodeID) + "/run?limit=" + strconv.Itoa(fleetDetailLimit), true
	case agent.ConversationID != "":
		return "/api/conversations/" + url.PathEscape(agent.ConversationID) + "/history?limit=" + strconv.Itoa(fleetDetailLimit), false
	}
	return "", false
}

func parseFleetDetail(path string, nodeRun bool, payload []byte) ([]fleetActivity, error) {
	if nodeRun {
		return parseFleetNodeRun(payload)
	}
	return parseFleetHistory(payload)
}

func (s *shellState) ensureFleetDetail(agent fleetAgent) {
	if s.conversationDataBlocked() {
		return
	}
	state := &s.fleet.detail
	if state.agentID == agent.ID && (state.loading || state.entries != nil || state.failed != "") {
		return
	}
	path, nodeRun := fleetDetailPath(agent)
	state.agentID = agent.ID
	state.entries = nil
	state.failed = ""
	if path == "" {
		state.loading = false
		state.failed = "这个 Agent 没有可读取的活动记录。"
		return
	}
	state.loading = true
	api := s.api
	go func() {
		payload, err := api.get(path)
		var activities []fleetActivity
		if err == nil {
			activities, err = parseFleetDetail(path, nodeRun, payload)
		}
		s.updates.post(s.window, func() {
			if s.fleet.detail.agentID != agent.ID || s.api != api {
				return
			}
			s.fleet.detail.loading = false
			if err != nil {
				s.fleet.detail.failed = "读不到最近活动：" + err.Error()
				return
			}
			s.fleet.detail.entries = activities
		})
	}()
}

func (s *shellState) refreshFleetDetail(agent fleetAgent) {
	state := &s.fleet.detail
	if state.loading || state.agentID != agent.ID {
		return
	}
	path, nodeRun := fleetDetailPath(agent)
	if path == "" {
		return
	}
	api := s.api
	go func() {
		payload, err := api.get(path)
		var activities []fleetActivity
		if err == nil {
			activities, err = parseFleetDetail(path, nodeRun, payload)
		}
		s.updates.post(s.window, func() {
			if err != nil || s.fleet.detail.agentID != agent.ID || s.api != api {
				return
			}
			if !reflect.DeepEqual(activities, s.fleet.detail.entries) {
				s.fleet.detail.entries = activities
				s.fleet.detail.failed = ""
			}
		})
	}()
}

func (s *shellState) fleetDetailAgent(id string) (*fleetAgent, string) {
	if agent, ok := fleetAgentByID(s.fleet.data, id); ok {
		return &agent, ""
	}
	if s.fleet.global == nil && !s.fleet.globalLoading && s.fleet.globalFailed == "" {
		s.ensureGlobalFleet()
	}
	if agent, ok := fleetAgentByID(s.fleet.global, id); ok {
		return &agent, ""
	}
	switch {
	case s.fleet.globalLoading:
		return nil, "正在读取全局编队…"
	case s.fleet.globalFailed != "":
		return nil, s.fleet.globalFailed
	case s.fleet.data != nil:
		return nil, "找不到这个 Agent（" + id + "）。"
	}
	return nil, ""
}

func fleetAccents() []ui.Color {
	return []ui.Color{
		palette.Blue500.Color(),
		palette.Violet500.Color(),
		palette.Teal500.Color(),
		palette.Green600.Color(),
		palette.Amber500.Color(),
		palette.Orange500.Color(),
		palette.Pink500.Color(),
		palette.Lime500.Color(),
	}
}

func fleetAccent(agent fleetAgent, group int) ui.Color {
	accents := fleetAccents()
	if agent.Kind == "global" {
		return accents[0]
	}
	return accents[(group+1)%len(accents)]
}

func fleetArtifactRowOf(artifact fleetArtifact) artifactRow {
	return artifactRow{
		artifactID: artifact.ArtifactID,
		taskID:     artifact.TaskID,
		namespace:  artifact.Namespace,
		name:       artifact.Name,
		title:      artifact.Title,
		mediaType:  artifact.MediaType,
		version:    artifact.Version,
		size:       artifact.Size,
	}
}

func (s *shellState) panelAgentDetail(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	page := s.boardPage()
	if page == nil || page.Kind != "agent" {
		return
	}
	id := fleetAgentIDOfPage(page.ID)
	if _, ok := fleetAgentByID(s.fleet.data, id); !ok && s.fleet.data == nil {
		text := "正在读取编队…"
		if s.fleet.failed != "" {
			text = s.fleet.failed
		}
		kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
		if !s.fleet.loading && s.fleet.failed == "" {
			s.ensureFleet()
		}
		return
	}
	agent, note := s.fleetDetailAgent(id)
	if agent == nil {
		if note != "" {
			kit.Text(ctx, note, t.Text.Sm).TextColor(t.Muted)
		}
		return
	}
	data := s.fleet.data
	if _, ok := fleetAgentByID(data, id); !ok {
		data = s.fleet.global
	}
	if data == nil {
		return
	}
	s.ensureFleetDetail(*agent)
	accent := fleetAccent(*agent, fleetGroupIndex(data, *agent))
	s.agentDetailHeader(ctx, *agent, data, accent, true)
	s.agentDetailStats(ctx, *agent)
	body := ui.Row(ctx).FillWidth().Gap(th.Space(2.5))
	body.Children(func() {
		left := ui.Column(ctx).Grow(3).FillHeight().Justify(ui.Start).Gap(th.Space(1.5))
		left.Children(func() { s.agentDetailActivity(ctx, *agent) })
		right := ui.Column(ctx).Grow(2).Gap(th.Space(1.5))
		right.Children(func() {
			s.agentDetailTasks(ctx, data, *agent)
			s.agentDetailEvents(ctx, data, *agent)
			s.agentDetailArtifacts(ctx, data, *agent)
			s.agentDetailRelations(ctx, data, *agent)
		})
	})
}

func (s *shellState) agentDetailHeader(ctx *ui.Context, agent fleetAgent, data *fleetSnapshot, accent ui.Color, withAction bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).FillWidth().Padding(th.Space(2)).Gap(th.Space(1)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, accent.Alpha(0.45))
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center).Children(func() {
			avatar := ui.Box(ctx).Size(th.Space(9), th.Space(9)).Radius(t.Radius.Full).Center().
				Background(accent.Alpha(0.2)).Border(gwtheme.Stroke, accent.Alpha(0.55))
			avatar.Children(func() {
				kit.Text(ctx, fleetAgentInitial(agent), t.Text.Lg).FontWeight(700).TextColor(accent)
			})
			column := ui.Column(ctx).Grow(1).Gap(th.Space(0.25))
			column.Children(func() {
				ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
					kit.Text(ctx, fleetAgentLabel(agent), t.Text.Lg).FontWeight(700).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
					fleetStatusDot(ctx, agent.Status)
					kit.Text(ctx, fleetStatusLabel(agent.Status), t.Text.Xs).TextColor(t.Muted)
					kit.Text(ctx, fleetAgentRole(agent), t.Text.Xs).TextColor(accent)
				})
				meta := []string{fleetAgentRole(agent)}
				if agent.Kind != "" {
					meta[0] = agent.Kind + " · " + fleetAgentRole(agent)
				}
				if agent.Model != "" {
					meta = append(meta, shortModel(agent.Model))
				}
				if agent.ProjectID != "" {
					meta = append(meta, "项目 "+agent.ProjectID)
				}
				if parent, ok := fleetParentOf(data, agent); ok {
					meta = append(meta, "父级 "+fleetAgentLabel(parent))
				}
				fleetEllipsis(ctx, joinFleetMeta(meta), t.Text.Sm, t.Muted)
				fleetEllipsis(ctx, "当前操作 · "+fleetOperation(agent), t.Text.Sm, t.Muted)
			})
			if withAction {
				actions := ui.Row(ctx).Gap(th.Space(1)).AlignItems(ui.Center)
				actions.Children(func() {
					button := kit.Button(ctx, "打开聊天", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm})
					button.OnClick(func() { go s.openFleetAgentChat(agent) })
				})
			}
		})
	})
}

func (s *shellState) agentDetailStats(ctx *ui.Context, agent fleetAgent) {
	th := ctx.Theme()
	recent := formatTrajectoryClock(agent.UpdatedAt)
	if s.fleet.detail.agentID == agent.ID && len(s.fleet.detail.entries) > 0 {
		recent = formatTrajectoryClock(s.fleet.detail.entries[len(s.fleet.detail.entries)-1].At)
	}
	cells := [][2]string{
		{"Tokens", formatTrajectoryCompactTokens(agent.Tokens)},
		{"成本", formatTrajectoryCost(agent.Cost)},
		{"请求", strconv.Itoa(agent.Requests)},
		{"消息", strconv.Itoa(agent.Messages)},
		{"最近活动", recent},
	}
	ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
		for _, cell := range cells {
			trajectoryStatCell(ctx, cell[0], cell[1])
		}
	})
}

func (s *shellState) agentDetailActivity(ctx *ui.Context, agent fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	section := ui.Column(ctx).FillWidth().Gap(th.Space(1)).Padding(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border)
	section.Children(func() {
		kit.Text(ctx, "最近活动 / 工作记录", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		state := &s.fleet.detail
		if state.agentID != agent.ID {
			kit.Text(ctx, "正在读取最近活动…", t.Text.Xs).TextColor(t.Muted)
			return
		}
		if state.failed != "" {
			kit.Text(ctx, state.failed, t.Text.Xs).TextColor(t.Muted)
			return
		}
		if state.loading {
			kit.Text(ctx, "正在读取最近活动…", t.Text.Xs).TextColor(t.Muted)
			return
		}
		if len(state.entries) == 0 {
			kit.Text(ctx, "最近没有活动记录。", t.Text.Xs).TextColor(t.Muted)
			return
		}
		for index := len(state.entries) - 1; index >= 0; index-- {
			entry := state.entries[index]
			line := strings.TrimSpace(entry.Role)
			if entry.Kind != "" {
				line = strings.TrimSpace(line + " · " + entry.Kind)
			}
			if line == "" {
				line = "记录"
			}
			ui.Column(ctx).FillWidth().Gap(th.Space(0.25)).Children(func() {
				ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
					kit.Text(ctx, line, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
					kit.Text(ctx, formatTrajectoryClock(entry.At), t.Text.Xs).TextColor(t.Muted)
				})
				text := firstLine(entry.Text, fleetDetailText)
				if text == "" {
					text = "（没有摘要）"
				}
				fleetEllipsis(ctx, text, t.Text.Sm, t.Foreground)
			})
		}
	})
}

func (s *shellState) agentDetailTasks(ctx *ui.Context, data *fleetSnapshot, agent fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	tasks := fleetTasksFor(data, agent)
	section := ui.Column(ctx).FillWidth().Gap(th.Space(0.75)).Padding(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border)
	section.Children(func() {
		kit.Text(ctx, "任务", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		if len(tasks) == 0 {
			kit.Text(ctx, "没有相关任务。", t.Text.Xs).TextColor(t.Muted)
			return
		}
		shown := tasks
		if len(shown) > fleetDetailTasksShown {
			shown = shown[:fleetDetailTasksShown]
		}
		for _, task := range shown {
			row := task
			ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
				fleetStatusDot(ctx, row.Status)
				kit.Text(ctx, row.Title, t.Text.Sm).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
				kit.Text(ctx, fleetStatusLabel(row.Status), t.Text.Xs).TextColor(t.Muted)
			})
		}
		if hidden := len(tasks) - len(shown); hidden > 0 {
			kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 个任务", t.Text.Xs).TextColor(t.Muted)
		}
	})
}

func (s *shellState) agentDetailEvents(ctx *ui.Context, data *fleetSnapshot, agent fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	events := fleetEventsFor(data, agent)
	index := fleetIndex(data)
	section := ui.Column(ctx).FillWidth().Gap(th.Space(0.75)).Padding(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border)
	section.Children(func() {
		kit.Text(ctx, "事件", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		if len(events) == 0 {
			kit.Text(ctx, "没有相关事件。", t.Text.Xs).TextColor(t.Muted)
			return
		}
		shown := events
		if len(shown) > fleetDetailEventShown {
			shown = shown[:fleetDetailEventShown]
		}
		for _, event := range shown {
			row := event
			line := fleetCategoryLabel(fleetEventCategory(row)) + " · " + fleetEventLine(index, row)
			fleetEllipsis(ctx, line, t.Text.Xs, t.Muted)
		}
		if hidden := len(events) - len(shown); hidden > 0 {
			kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 条事件", t.Text.Xs).TextColor(t.Muted)
		}
	})
}

func (s *shellState) agentDetailArtifacts(ctx *ui.Context, data *fleetSnapshot, agent fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	artifacts := fleetArtifactsFor(data, agent)
	section := ui.Column(ctx).FillWidth().Gap(th.Space(0.75)).Padding(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border)
	section.Children(func() {
		kit.Text(ctx, "共享产物", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		if len(artifacts) == 0 {
			kit.Text(ctx, "没有相关产物。", t.Text.Xs).TextColor(t.Muted)
			return
		}
		shown := artifacts
		if len(shown) > fleetDetailArtifacts {
			shown = shown[:fleetDetailArtifacts]
		}
		for _, artifact := range shown {
			row := artifact
			label := artifactLabel(fleetArtifactRowOf(row))
			button := kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			button.Justify(ui.Start).FillWidth().OnClick(func() { s.openFleetArtifact(row) })
		}
		if hidden := len(artifacts) - len(shown); hidden > 0 {
			kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 件产物", t.Text.Xs).TextColor(t.Muted)
		}
	})
}

func (s *shellState) agentDetailRelations(ctx *ui.Context, data *fleetSnapshot, agent fleetAgent) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	section := ui.Column(ctx).FillWidth().Gap(th.Space(0.75)).Padding(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border)
	section.Children(func() {
		kit.Text(ctx, "关系", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		if parent, ok := fleetParentOf(data, agent); ok {
			row := parent
			button := kit.Button(ctx, "父级 "+fleetAgentLabel(row), kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			button.Label("关系 Agent " + fleetAgentLabel(row))
			button.Justify(ui.Start).FillWidth().OnClick(func() { go s.openFleetAgentChat(row) })
		} else if agent.ParentID != "" {
			kit.Text(ctx, "父级不在当前编队范围里。", t.Text.Xs).TextColor(t.Muted)
		} else {
			kit.Text(ctx, "它是编队的根。", t.Text.Xs).TextColor(t.Muted)
		}
		children := fleetChildrenOf(data, agent)
		for _, child := range children {
			member := child
			button := kit.Button(ctx, "下级 "+fleetAgentLabel(member), kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
			button.Label("关系 Agent " + fleetAgentLabel(member))
			button.Justify(ui.Start).FillWidth().OnClick(func() { go s.openFleetAgentChat(member) })
		}
		if len(children) > 0 {
			kit.Text(ctx, formatFleetCount(len(children))+" 个直接下级", t.Text.Xs).TextColor(t.Muted)
		}
	})
}
