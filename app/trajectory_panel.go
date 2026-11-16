package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) panelTrajectory(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	state := &s.trajectory
	s.scopeLine(ctx, "")
	if state.data != nil && state.scopeKey != s.chatScope().key() {
		if !state.loading() {
			go s.ensureTrajectory()
		}
		skeletonTrajectoryPage(ctx)
		return
	}
	if state.data == nil {
		if state.failed != "" {
			kit.Text(ctx, state.failed, t.Text.Sm).TextColor(t.Muted)
		} else {
			skeletonTrajectoryPage(ctx)
		}
		if !state.loading() && (state.failed == "" || state.scopeKey != s.chatScope().key()) {
			go s.ensureTrajectory()
		}
		return
	}
	totals := state.data.Totals
	for _, cards := range [][][2]string{
		{{"轮次", strconv.Itoa(totals.Turns)}, {"工具调用", strconv.Itoa(totals.ToolCalls)}, {"工具失败", strconv.Itoa(totals.ToolErrors)}},
		{{"Tokens", formatTrajectoryTokens(totals.TotalTokens)}, {"缓存命中", formatTrajectoryPercent(totals.CacheHitRate)}, {"成本", formatTrajectoryCost(totals.Cost)}},
		{{"总用时", formatTrajectoryDuration(totals.DurationMs)}, {"输入", formatTrajectoryTokens(totals.Input)}, {"输出", formatTrajectoryTokens(totals.Output)}},
	} {
		group := cards
		ui.Row(ctx).FillWidth().Gap(th.Space(2)).Children(func() {
			for _, card := range group {
				s.statCard(ctx, card[0], card[1])
			}
		})
	}
	kit.Separator(ctx, false)
	if len(state.data.Turns) == 0 {
		kit.Text(ctx, "这个会话还没有可量化的回合。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	start := 0
	if len(state.data.Turns) > 20 {
		start = len(state.data.Turns) - 20
		kit.Text(ctx, "只显示最近 20 轮，更早的已收起。", t.Text.Xs).TextColor(t.Muted)
	}
	for _, turn := range state.data.Turns[start:] {
		s.trajectoryTurnRow(ctx, turn)
	}
}

func (s *shellState) trajectoryTurnRow(ctx *ui.Context, turn trajectoryTurn) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).FillWidth().Padding(th.Space(2)).Gap(th.Space(1)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
	card.Children(func() {
		head := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center)
		head.Children(func() {
			kit.Text(ctx, "第 "+strconv.Itoa(turn.Index)+" 轮", t.Text.Sm).FontWeight(600)
			kit.Text(ctx, trajectoryStatusLabel(turn.Status), t.Text.Xs).TextColor(t.Muted)
			if turn.Model != "" {
				kit.Text(ctx, turn.Model, t.Text.Xs).TextColor(t.Muted)
			}
			ui.Spacer(ctx)
			kit.Text(ctx, formatTrajectoryDuration(turn.DurationMs), t.Text.Xs).TextColor(t.Muted)
		})
		usage := formatTrajectoryTokens(turn.Usage.Total) + " tokens"
		if turn.CacheHitRate > 0 {
			usage += " · 缓存 " + formatTrajectoryPercent(turn.CacheHitRate)
		}
		if turn.Cost > 0 {
			usage += " · " + formatTrajectoryCost(turn.Cost)
		}
		if turn.Usage.FirstTokenMs > 0 {
			usage += " · 首 token " + formatTrajectoryDuration(turn.Usage.FirstTokenMs)
		}
		if len(turn.Invocations) > 0 {
			usage += " · " + strconv.Itoa(len(turn.Invocations)) + " 次请求"
		}
		kit.Text(ctx, usage, t.Text.Xs).TextColor(t.Muted)
		if tools := trajectoryToolNames(turn.ToolCalls); tools != "" {
			line := strconv.Itoa(len(turn.ToolCalls)) + " 次工具 · " + tools
			kit.Text(ctx, line, t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
		}
	})
}

func trajectoryStatusLabel(status string) string {
	switch workStatusOf(status) {
	case workDone, workUnknown:
		if strings.TrimSpace(status) == "" {
			return "完成"
		}
	case workRunning, workPending:
		return "进行中"
	case workBlocked:
		return "阻塞"
	case workFailed:
		return "失败"
	case workStopped:
		return "已停止"
	}
	return status
}
