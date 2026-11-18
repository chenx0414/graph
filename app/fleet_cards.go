package main

import (
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func fleetStatusColor(t gwtheme.Tokens, status string) ui.Color {
	switch toneOf(workStatusOf(status)) {
	case toneActive:
		return t.Unread
	case toneSuccess:
		return t.Success
	case toneAttention:
		return t.Attention
	case toneDanger:
		return t.Danger
	}
	return t.Idle
}

func fleetStatusDot(ctx *ui.Context, status string) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	return ui.Box(ctx).Size(th.Space(2), th.Space(2)).Radius(t.Radius.Full).Background(fleetStatusColor(t, status))
}

func fleetChip(ctx *ui.Context, label, text string, selected bool, action func()) {
	button := kit.Button(ctx, text, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm})
	button.Label(label)
	if selected {
		button.Background(gwtheme.Of(ctx).SidebarSelected)
	}
	button.OnClick(action)
}

func fleetEllipsis(ctx *ui.Context, text string, size float32, color ui.Color) ui.Element {
	row := ui.Row(ctx).FillWidth().PaddingEnd(ctx.Theme().Space(2)).Clip()
	row.Children(func() {
		kit.Text(ctx, text, size).TextColor(color).Grow(1).SingleLine().Ellipsis("…")
	})
	return row
}

func (s *shellState) panelFleetKPI(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if s.fleet.data == nil {
		if !s.fleetUnavailable(ctx) {
			skeletonFleetKPIs(ctx)
		}
		return
	}
	data := s.fleetData(ctx)
	if data == nil {
		return
	}
	cells := [][2]string{
		{"Agent 数", formatFleetCount(data.Stats.Agents)},
		{"运行中", formatFleetCount(data.Stats.Running)},
		{"工作项", formatFleetCount(data.Stats.Tasks)},
		{"消息数", formatFleetCount(data.Stats.Messages)},
		{"Tokens", formatTrajectoryCompactTokens(data.Stats.Tokens)},
		{"成本", formatTrajectoryCost(data.Stats.Cost)},
	}
	ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
		for _, cell := range cells {
			trajectoryStatCell(ctx, cell[0], cell[1])
		}
	})
	caption := "编队范围 · 共 " + formatFleetCount(len(data.Agents)) + " 个 Agent · " + strconv.Itoa(len(fleetGroups(data))) + " 个项目分组"
	if data.Truncated {
		caption += " · 事件与产物已截断"
	}
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
		kit.Text(ctx, caption, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
		kit.Button(ctx, "历史图", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Label("浏览历史图").OnClick(func() {
			s.openFleetHistoryPage("")
		})
		kit.Button(ctx, "刷新", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Label("刷新编队").OnClick(func() {
			s.refreshFleet()
		})
	})
}

func (s *shellState) panelFleetEvents(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if s.fleet.data == nil {
		if !s.fleetUnavailable(ctx) {
			skeletonFleetRows(ctx, 5)
		}
		return
	}
	data := s.fleetData(ctx)
	if data == nil {
		return
	}
	if len(data.Events) == 0 {
		kit.Text(ctx, "还没有可检查的事件。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	ui.Row(ctx).Wrap().Gap(th.Space(1)).Children(func() {
		for _, category := range fleetCategories() {
			current := category
			text := fleetCategoryLabel(current)
			if current == "" {
				text = "全部"
			}
			fleetChip(ctx, "筛选 "+text, text, s.fleet.category == current, func() {
				s.selectFleetCategory(current)
			})
		}
	})
	events := fleetFilteredEvents(data, "", s.fleet.category)
	if len(events) == 0 {
		kit.Text(ctx, "没有匹配的事件。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	index := fleetIndex(data)
	shown := events
	if len(shown) > fleetEventLimit {
		shown = shown[:fleetEventLimit]
	}
	for _, event := range shown {
		row := event
		ui.Column(ctx).FillWidth().Gap(th.Space(0.25)).Children(func() {
			ui.Row(ctx).FillWidth().PaddingEnd(th.Space(2)).Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.Type, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
				kit.Text(ctx, formatTrajectoryClock(row.At), t.Text.Xs).TextColor(t.Muted)
			})
			fleetEllipsis(ctx, fleetEventLine(index, row), t.Text.Sm, t.Foreground)
		})
	}
	if hidden := len(events) - len(shown); hidden > 0 {
		kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 条事件未列出", t.Text.Xs).TextColor(t.Muted)
	}
}

func (s *shellState) panelFleetArtifacts(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if s.fleet.data == nil {
		if !s.fleetUnavailable(ctx) {
			skeletonFleetRows(ctx, 3)
		}
		return
	}
	data := s.fleetData(ctx)
	if data == nil {
		return
	}
	if len(data.Artifacts) == 0 {
		kit.Text(ctx, "还没有共享产物。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	shown := 0
	for _, group := range fleetArtifactGroups(data) {
		if shown >= fleetArtifactLimit {
			break
		}
		kit.Text(ctx, group.Producer+" 的产物", t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		for _, artifact := range group.Artifacts {
			if shown >= fleetArtifactLimit {
				break
			}
			row := artifact
			entry := artifactRow{
				artifactID: row.ArtifactID,
				taskID:     row.TaskID,
				namespace:  row.Namespace,
				name:       row.Name,
				title:      row.Title,
				mediaType:  row.MediaType,
				version:    row.Version,
				size:       row.Size,
			}
			card := ui.Column(ctx).FillWidth().Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.25)).
				Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border).Focusable()
			card.Label("共享产物 " + artifactLabel(entry))
			hovered := card.Hovered()
			if hovered {
				card.Background(t.HoverTint).Border(gwtheme.Stroke, t.Unread)
			}
			card.OnClick(func() { s.openFleetArtifact(row) })
			card.Children(func() {
				fleetEllipsis(ctx, artifactLabel(entry), t.Text.Sm, t.Foreground)
				task := row.TaskID
				if task == "" {
					task = row.ProducerTaskID
				}
				if task != "" {
					fleetEllipsis(ctx, "任务 "+task, t.Text.Xs, t.Muted)
				}
			})
			shown++
		}
	}
	if hidden := len(data.Artifacts) - shown; hidden > 0 {
		kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 件产物未列出", t.Text.Xs).TextColor(t.Muted)
	}
}
