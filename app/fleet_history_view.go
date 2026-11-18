package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// panelFleetHistory is the user-visible history browser. It shows every task
// of the selected project -- including completed/stopped/failed -- and never
// hides the remainder behind a "还有 N 个未列出" note.
func (s *shellState) panelFleetHistory(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	page := s.boardPage()
	projectID := ""
	if page != nil {
		projectID = fleetHistoryProjectOfPage(page.ID)
	}
	state := &s.fleetHistory
	if state.projectID != projectID || (state.tasks == nil && !state.loading && state.failed == "") {
		s.ensureFleetHistory()
	}
	tasks := state.tasks
	if tasks == nil {
		if state.failed != "" {
			kit.Text(ctx, state.failed, t.Text.Sm).TextColor(t.Danger)
			kit.Button(ctx, "重试", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).OnClick(func() {
				s.refreshFleetHistory()
				s.frame()
			})
			return
		}
		if !state.loading {
			kit.Text(ctx, "正在读取历史图…", t.Text.Sm).TextColor(t.Muted)
		}
		return
	}

	projects := historyGraphProjects(tasks)
	ui.Row(ctx).FillWidth().Wrap().Gap(th.Space(1)).Children(func() {
		for _, id := range projects {
			selected := id == projectID
			label := "全部项目"
			if id != "" {
				label = id
			}
			fleetChip(ctx, "历史图项目 "+label, label, selected, func() {
				s.openFleetHistoryPage(id)
			})
		}
	})

	shown := historyGraphsOfProject(tasks, projectID)
	ui.Row(ctx).FillWidth().AlignItems(ui.Center).Gap(th.Space(1)).Children(func() {
		kit.Text(ctx, "共 "+strconv.Itoa(len(shown))+" 个历史图（含已完成、已停止）", t.Text.Xs).TextColor(t.Muted).Grow(1)
		kit.Button(ctx, "刷新", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Label("刷新历史图").OnClick(func() {
			s.refreshFleetHistory()
			s.frame()
		})
	})
	if len(shown) == 0 {
		kit.Text(ctx, "这个项目还没有历史图。", t.Text.Sm).TextColor(t.Muted)
		return
	}

	// Every task gets a row; no truncation and no hidden remainder.
	for _, task := range shown {
		row := task
		card := ui.Column(ctx).FillWidth().Clip().Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.35)).
			Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border).Focusable()
		card.Label("历史图 " + historyGraphTitle(row))
		if card.Hovered() {
			card.Background(t.HoverTint).Border(gwtheme.Stroke, t.Unread)
		}
		card.OnClick(func() { s.openHistoryGraph(row) })
		card.Children(func() {
			ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
				fleetStatusDot(ctx, historyGraphAPIStatus(row))
				kit.Text(ctx, historyGraphTitle(row), t.Text.Sm).FontWeight(600).TextColor(t.Foreground).Grow(1).
					SingleLine().Ellipsis("…")
				kit.Text(ctx, fleetStatusLabel(historyGraphAPIStatus(row)), t.Text.Xs).TextColor(t.Muted)
			})
			meta := historyGraphMeta(row)
			if meta != "" {
				fleetEllipsis(ctx, meta, t.Text.Xs, t.Muted)
			}
			ui.Row(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
				kit.Button(ctx, "打开图", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).
					Label("打开图 " + historyGraphTitle(row)).OnClick(func() { s.openHistoryGraph(row) })
				if row.ConversationID != "" {
					kit.Button(ctx, "打开会话", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).
						Label("打开会话 " + historyGraphTitle(row)).OnClick(func() { s.openHistoryGraphSession(row) })
				}
				kit.Text(ctx, row.ID, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
			})
		})
	}
}

func historyGraphMeta(task historyGraph) string {
	parts := []string{}
	if task.Phase != "" {
		parts = append(parts, "阶段 "+task.Phase)
	}
	if task.ProjectID != "" {
		parts = append(parts, "项目 "+task.ProjectID)
	}
	if task.CreatedAt > 0 {
		parts = append(parts, "创建 "+formatTrajectoryClock(task.CreatedAt))
	}
	if task.UpdatedAt > 0 {
		parts = append(parts, "更新 "+formatTrajectoryClock(task.UpdatedAt))
	}
	if task.OpenQuestions > 0 {
		parts = append(parts, strconv.Itoa(task.OpenQuestions)+" 个待处理问题")
	}
	return strings.Join(parts, " · ")
}
