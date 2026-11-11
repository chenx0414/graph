package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

func (s *shellState) boardPanelBody(ctx *ui.Context, panel *boardPanel) {
	switch panel.Kind {
	case "overview":
		s.panelOverview(ctx)
	case "conversation":
		s.panelConversation(ctx)
	case "history":
		s.panelHistory(ctx)
	case "tasks":
		s.panelTasks(ctx)
	case "graph":
		s.panelGraph(ctx, panel.Expanded)
	case "artifacts":
		s.panelArtifacts(ctx)
	case "models":
		s.panelModels(ctx)
	case "questions":
		s.panelQuestions(ctx)
	case "capabilities":
		s.panelCapabilities(ctx)
	case "settings":
		s.panelSettings(ctx)
	}
}

func (s *shellState) boardNote(ctx *ui.Context, text string) {
	ui.Text(ctx, text).FontSize(12).TextColor(ctx.Theme().TextMuted)
}

func (s *shellState) boardMatches(text string) bool {
	query := strings.TrimSpace(s.board.query)
	if query == "" {
		return true
	}
	return strings.Contains(strings.ToLower(text), strings.ToLower(query))
}

func (s *shellState) statCard(ctx *ui.Context, label, value string) {
	t := ctx.Theme()
	ui.Column(ctx).Width(118).Height(54).Radius(11).Border(1, t.Border).Background(t.Surface).Padding(8).
		Justify(ui.SpaceBetween).Children(func() {
		ui.Text(ctx, value).FontSize(15).FontWeight(600).TextColor(t.Text)
		ui.Text(ctx, label).FontSize(10).TextColor(t.TextMuted)
	})
}

func cacheLabel(usage *usageState) string {
	if usage == nil {
		return "—"
	}
	return formatPercent(usage.rows.cacheHit)
}

func (s *shellState) panelOverview(ctx *ui.Context) {
	t := ctx.Theme()
	if s.usage == nil {
		s.ensureUsage()
	}
	ui.Row(ctx).Wrap().Gap(8).Children(func() {
		s.statCard(ctx, "会话", strconv.Itoa(len(s.conversations)))
		s.statCard(ctx, "项目", strconv.Itoa(len(s.projectNames())))
		cost, tokens := "—", "—"
		if s.usage != nil {
			cost = formatCost(s.usage.rows.costMicros)
			tokens = formatTokens(s.usage.rows.tokens)
		}
		s.statCard(ctx, "用量", cost)
		s.statCard(ctx, "缓存命中", cacheLabel(s.usage))
		capabilityValue := "—"
		if s.usage != nil {
			ready := s.usage.rows.capabilities.ready
			missing := s.usage.rows.capabilities.missing
			capabilityValue = strconv.Itoa(ready) + "/" + strconv.Itoa(ready+missing)
		}
		s.statCard(ctx, "能力库", capabilityValue)
		s.statCard(ctx, "tokens", tokens)
	})
	if active := s.active(); active != nil {
		ui.Text(ctx, "当前会话 · "+s.titleOf(s.activeID) + " · " + active.status).FontSize(12).TextColor(t.TextMuted)
	}
}

func (s *shellState) panelConversation(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	ui.Text(ctx, s.titleOf(s.activeID)).FontSize(14).TextColor(t.Text)
	ui.Text(ctx, "状态 · "+active.status).FontSize(12).TextColor(t.TextMuted)
	if active.currentModel != "" {
		ui.Text(ctx, "模型 · "+shortModel(active.currentModel)+" · "+active.currentThinking).FontSize(12).TextColor(t.TextMuted)
	}
	ui.Text(ctx, "轮次 · 消息 "+strconv.Itoa(len(active.messages))).FontSize(12).TextColor(t.TextMuted)
}

func (s *shellState) panelHistory(ctx *ui.Context) {
	t := ctx.Theme()
	shown := 0
	for _, conversation := range s.conversations {
		if !s.boardMatches(conversation.Title + " " + conversation.ProjectID) {
			continue
		}
		label := strings.TrimSpace(conversation.Title)
		if label == "" {
			label = "（无标题）"
		}
		ui.Row(ctx).FillWidth().Gap(8).Children(func() {
			ui.Text(ctx, label).FontSize(12).TextColor(t.Text).Grow(1).SingleLine().Ellipsis("…")
			ui.Text(ctx, conversation.Status).FontSize(11).TextColor(t.TextMuted)
		})
		shown++
	}
	if shown == 0 {
		s.boardNote(ctx, "没有匹配的历史记录。")
	}
}

func (s *shellState) panelTasks(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil || len(active.tasks) == 0 {
		s.boardNote(ctx, "当前会话还没有任务。任务启动后会在这里列出。")
		return
	}
	for _, task := range active.tasks {
		ui.Text(ctx, taskLabel(task)).FontSize(12).TextColor(t.Text)
		for _, node := range task.nodes {
			ui.Text(ctx, "  "+nodeLabel(node)).FontSize(11).TextColor(t.TextMuted)
		}
	}
}

func (s *shellState) ensureGraph() {
	active := s.active()
	if active == nil || len(active.tasks) == 0 || active.graphLoading {
		return
	}
	taskID := active.tasks[0].id
	if active.graphTaskID == taskID && len(active.graph.nodes) > 0 {
		return
	}
	active.graphLoading = true
	go active.loadGraph(taskID)
}

func (s *shellState) panelGraph(ctx *ui.Context, expanded bool) {
	t := ctx.Theme()
	active := s.active()
	if active == nil || len(active.tasks) == 0 {
		s.boardNote(ctx, "图谱会在任务启动后出现：节点是 Agent，连线是接口投递。")
		return
	}
	if len(active.graph.nodes) == 0 {
		s.ensureGraph()
		s.boardNote(ctx, "正在读取图谱…")
		return
	}
	if active.graphError != "" {
		s.boardNote(ctx, active.graphError)
		return
	}
	caption := strconv.Itoa(len(active.graph.nodes)) + " 个节点 · " + strconv.Itoa(len(active.graph.edges)) + " 条连接"
	ui.Text(ctx, caption).FontSize(11).TextColor(t.TextMuted)
	height := float32(220)
	if expanded {
		height = 590
	}
	ui.Box(ctx).FillWidth().Height(height).Clip().Draw(func(p *ui.Painter, r ui.Rect) {
		drawBoardGraph(p, r, active.graph)
	})
}

func (s *shellState) panelArtifacts(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	if len(active.artifacts) == 0 {
		s.boardNote(ctx, "这个会话还没有共享产物。")
		return
	}
	ui.Text(ctx, "共 "+strconv.Itoa(len(active.artifacts))+" 件").FontSize(11).TextColor(t.TextMuted)
	if active.preview != "" {
		ui.Row(ctx).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Text(ctx, "预览 · "+active.previewTitle).FontSize(11).TextColor(t.TextMuted).Grow(1).SingleLine()
			row := active.previewRow
			if ui.Button(ctx, "导出").Clicked() {
				go active.exportArtifactNow(row)
			}
		})
		ui.Text(ctx, active.preview).FontSize(11)
	}
	shown := active.artifacts
	hidden := 0
	if len(shown) > artifactListLimit {
		hidden = len(shown) - artifactListLimit
		shown = shown[:artifactListLimit]
	}
	for _, artifact := range shown {
		row := artifact
		if !s.boardMatches(artifactLabel(row)) {
			continue
		}
		if ui.Button(ctx, artifactLabel(row)).AlignSelf(ui.Start).Clicked() {
			go active.showArtifact(row)
		}
	}
	if hidden > 0 {
		ui.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 件未列出").FontSize(11).TextColor(t.TextMuted)
	}
}

func (s *shellState) panelModels(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	if len(active.models) == 0 {
		active.loadModels()
		s.boardNote(ctx, "正在读取模型…")
		return
	}
	if active.currentModel != "" {
		ui.Text(ctx, "当前 · "+shortModel(active.currentModel)+" · "+active.currentThinking).FontSize(12).TextColor(t.TextMuted)
	}
	for _, choice := range active.models {
		model := choice
		ui.Row(ctx).FillWidth().Gap(6).Children(func() {
			ui.Text(ctx, shortModel(model.id)).FontSize(12).TextColor(t.Text).Grow(1).SingleLine().Ellipsis("…")
			for _, level := range thinkingLevels(model) {
				levelValue := level
				if ui.Button(ctx, levelValue).Clicked() {
					go active.selectModel(model, levelValue)
				}
			}
		})
	}
}

func thinkingLevels(model modelChoice) []string {
	if len(model.available) == 0 {
		return []string{model.thinking}
	}
	return model.available
}

func (s *shellState) panelQuestions(ctx *ui.Context) {
	t := ctx.Theme()
	active := s.active()
	if active == nil || len(active.questions) == 0 {
		s.boardNote(ctx, "没有待你决定的问题。")
		return
	}
	for _, question := range active.questions {
		card := question
		ui.Column(ctx).Gap(4).Children(func() {
			ui.Text(ctx, "需要你决定 · "+card.Kind).FontSize(11).TextColor(t.TextMuted)
			ui.Text(ctx, card.Data.Prompt).FontSize(12)
			ui.Row(ctx).Gap(4).Wrap().Children(func() {
				for _, option := range card.Data.Options {
					value := option
					if ui.Button(ctx, value).Clicked() {
						go active.answer(card, value)
					}
				}
			})
		})
	}
}

func (s *shellState) panelCapabilities(ctx *ui.Context) {
	if s.resources == nil {
		s.ensureResources()
		s.boardNote(ctx, "正在读取能力库…")
		return
	}
	s.resources.view(ctx)
}

func (s *shellState) panelSettings(ctx *ui.Context) {
	if s.settings == nil {
		s.ensureSettings()
		s.boardNote(ctx, "正在读取设置…")
		return
	}
	s.settings.view(ctx)
}
