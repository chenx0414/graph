package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) boardPanelBody(ctx *ui.Context, panel *boardPanel) {
	switch panel.Kind {
	case "overview":
		s.panelOverview(ctx)
	case "conversation":
		s.panelConversation(ctx)
	case "history":
		s.panelHistory(ctx)
	case "agent":
		s.panelChatAgent(ctx)
	case "agent-network":
		s.panelChatNetwork(ctx, s.panelScope())
	case "trajectory":
		s.panelTrajectory(ctx)
	case "insights":
		s.panelInsights(ctx)
	case "trajectory-summary":
		s.trajectorySummaryCard(ctx)
	case "trajectory-tokens":
		s.trajectoryTokensCard(ctx)
	case "trajectory-timing":
		s.trajectoryTimingCard(ctx)
	case "context-overview":
		s.panelContextOverview(ctx)
	case "trajectory-trend":
		s.trajectoryTrendCard(ctx)
	case "trajectory-events":
		s.trajectoryEventsCard(ctx)
	case "trajectory-commands":
		s.trajectoryCommandsCard(ctx)
	case "trajectory-files":
		s.trajectoryFilesCard(ctx)
	case "trajectory-composition":
		s.trajectoryCompositionCard(ctx)
	case "trajectory-requests":
		s.trajectoryRequestsCard(ctx)
	case "trajectory-agents":
		s.trajectoryAgentsCard(ctx)
	case "trajectory-request-detail":
		s.trajectoryRequestDetailCard(ctx)
	case "insights-kpi":
		s.insightsKPICard(ctx)
	case "insights-days":
		s.insightsDaysCard(ctx)
	case "insights-sessions":
		s.insightsSessionsCard(ctx)
	case "tasks":
		s.panelTasks(ctx)
	case "artifacts":
		s.panelArtifacts(ctx)
	case "models":
		s.panelModels(ctx)
	case "questions":
		s.panelQuestions(ctx)
	case "providers":
		s.panelProviders(ctx)
	case "capabilities":
		s.panelCapabilities(ctx)
	case "assemblies":
		s.panelAssemblies(ctx)
	case "settings":
		s.panelSettings(ctx)
	case "fleet-kpi":
		s.panelFleetKPI(ctx)

	case "fleet-collaboration":
		s.panelFleetCollaboration(ctx)
	case "fleet-tasks":
		s.panelFleetTasks(ctx)
	case "fleet-events":
		s.panelFleetEvents(ctx)
	case "fleet-artifacts":
		s.panelFleetArtifacts(ctx)
	case "agent-detail":
		s.panelAgentDetail(ctx)
	case "graph-dag":
		s.panelFleetGraph(ctx)
	}
}

func (s *shellState) boardNote(ctx *ui.Context, text string) {
	t := gwtheme.Of(ctx)
	kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
}

func (s *shellState) statCard(ctx *ui.Context, label, value string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	card := ui.Column(ctx).Width(th.Space(29)).Height(th.Space(15)).Radius(t.Radius.Lg).Background(t.Card).
		Border(gwtheme.Hairline, t.Border).Padding(th.Space(2)).Justify(ui.SpaceBetween)
	card.Children(func() {
		kit.Text(ctx, value, t.Text.Xl).FontWeight(600).TextColor(t.Foreground)
		kit.Text(ctx, label, t.Text.Xs).TextColor(t.Muted)
	})
}

func cacheLabel(usage *usageState) string {
	if usage == nil {
		return "—"
	}
	return formatPercent(usage.rows.cacheHit)
}

func (s *shellState) panelOverview(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if s.usage == nil {
		s.ensureUsage()
	}
	if s.usage != nil && skeletonLoadingStatus(s.usage.status) {
		skeletonOverviewPage(ctx)
		return
	}
	ui.Row(ctx).Wrap().Gap(th.Space(2)).Children(func() {
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
			total := s.usage.rows.capabilities.total
			capabilityValue = strconv.Itoa(ready) + "/" + strconv.Itoa(total)
		}
		s.statCard(ctx, "资源库", capabilityValue)
		s.statCard(ctx, "tokens", tokens)
	})
	if active := s.active(); active != nil {
		if active.loading {
			kit.SkeletonLine(ctx, 38, th.Space(1.75))
		} else {
			kit.Text(ctx, "当前会话 · "+s.titleOf(s.activeID)+" · "+active.status, t.Text.Xs).TextColor(t.Muted)
		}
	}
}

func (s *shellState) panelConversation(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	kit.Text(ctx, s.titleOf(s.activeID), t.Text.Base).FontWeight(600).TextColor(t.Foreground)
	if active.loading {
		kit.SkeletonLine(ctx, 34, ctx.Theme().Space(1.75))
	} else {
		kit.Text(ctx, "状态 · "+active.status, t.Text.Sm).TextColor(t.Muted)
	}
	if active.currentModel != "" {
		kit.Text(ctx, "模型 · "+shortModel(active.currentModel)+" · "+active.currentThinking, t.Text.Sm).TextColor(t.Muted)
	}
	kit.Text(ctx, "消息 "+strconv.Itoa(len(active.messages))+" 条", t.Text.Sm).TextColor(t.Muted)
}

func (s *shellState) panelHistory(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	shown := 0
	for _, conversation := range s.conversations {
		label := strings.TrimSpace(conversation.Title)
		if label == "" {
			label = "（无标题）"
		}
		ui.Row(ctx).FillWidth().Gap(th.Space(2)).Children(func() {
			kit.Text(ctx, label, t.Text.Sm).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			kit.Text(ctx, conversation.Status, t.Text.Xs).TextColor(t.Muted)
		})
		shown++
	}
	if shown == 0 {
		s.boardNote(ctx, "没有匹配的历史记录。")
	}
}

func (s *shellState) scopeLineGlobal(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	kit.Text(ctx, "全体 Agent · 安装级统计", t.Text.Xs).TextColor(t.Muted)
}

func (s *shellState) scopeLine(ctx *ui.Context, fallback string) {
	t := gwtheme.Of(ctx)
	text := fallback
	switch scope := s.chatScope(); scope.Kind {
	case "node":
		text = "当前 Agent · " + s.titleOf(s.activeID)
	case "conversation":
		text = "当前会话 · " + s.titleOf(s.activeID)
	}
	kit.Text(ctx, text, t.Text.Xs).TextColor(t.Muted)
}

func (s *shellState) panelTasks(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	s.scopeLine(ctx, "全体 Agent · 安装级")
	active := s.active()
	if active == nil || len(active.tasks) == 0 {
		if s.chatScope().Kind == "node" {
			s.boardNote(ctx, "这个 Agent 还没有任务记录。")
			return
		}
		s.boardNote(ctx, "当前会话还没有任务。任务启动后会在这里列出。")
		return
	}
	for _, task := range active.tasks {
		kit.Text(ctx, taskLabel(task), t.Text.Sm).TextColor(t.Foreground)
		for _, node := range task.nodes {
			ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, nodeLabel(node), t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
				s.definitionLink(ctx, t, node.definition)
			})
		}
	}
}

func (s *shellState) panelArtifacts(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	s.scopeLine(ctx, "全体 Agent · 安装级")
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	if len(active.artifacts) == 0 && active.preview == "" {
		if s.chatScope().Kind == "node" {
			s.boardNote(ctx, "这个 Agent 还没有共享产物。")
			return
		}
		s.boardNote(ctx, "这个会话还没有共享产物。")
		return
	}
	kit.Text(ctx, "共 "+strconv.Itoa(len(active.artifacts))+" 件", t.Text.Xs).TextColor(t.Muted)
	if active.preview != "" {
		ui.Row(ctx).Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, "预览 · "+active.previewTitle, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine()
			row := active.previewRow
			if kit.Button(ctx, "导出", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
				go active.exportArtifactNow(row)
			}
		})
		kit.Text(ctx, active.preview, t.Text.Xs)
	}
	shown := active.artifacts
	hidden := 0
	if len(shown) > artifactListLimit {
		hidden = len(shown) - artifactListLimit
		shown = shown[:artifactListLimit]
	}
	for _, artifact := range shown {
		row := artifact
		button := kit.Button(ctx, artifactLabel(row), kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm})
		button.Justify(ui.Start).FillWidth()
		if button.Clicked() {
			go active.showArtifact(row)
		}
	}
	if hidden > 0 {
		kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 件未列出", t.Text.Xs).TextColor(t.Muted)
	}
}

func (s *shellState) panelModels(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	active := s.active()
	if active == nil {
		s.boardNote(ctx, "还没有选中的会话。")
		return
	}
	if len(active.models) == 0 {
		active.loadModels()
		if active.modelsLoading {
			skeletonModelsPanel(ctx)
			return
		}
		s.boardNote(ctx, "没有可用模型。")
		return
	}
	if active.currentModel != "" {
		kit.Text(ctx, "当前 · "+shortModel(active.currentModel)+" · "+active.currentThinking, t.Text.Xs).TextColor(t.Muted)
	}
	for _, choice := range active.models {
		model := choice
		ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
			kit.Text(ctx, shortModel(model.id), t.Text.Sm).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			for _, level := range thinkingLevels(model) {
				levelValue := level
				if kit.Button(ctx, levelValue, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
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
	t, th := gwtheme.Of(ctx), ctx.Theme()
	active := s.active()
	if active == nil || len(active.questions) == 0 {
		s.boardNote(ctx, "没有待你决定的问题。")
		return
	}
	for _, question := range active.questions {
		card := question
		ui.Column(ctx).Gap(th.Space(1)).Children(func() {
			kit.Text(ctx, "需要你决定 · "+card.Kind, t.Text.Xs).TextColor(t.Muted)
			kit.Text(ctx, card.Data.Prompt, t.Text.Sm)
			ui.Row(ctx).Gap(th.Space(1)).Wrap().Children(func() {
				for _, option := range card.Data.Options {
					value := option
					if kit.Button(ctx, value, kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
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
		skeletonResourcesPage(ctx)
		return
	}
	s.resources.view(ctx)
}

func (s *shellState) panelAssemblies(ctx *ui.Context) {
	if s.assemblies == nil {
		s.ensureAssemblies()
		skeletonAssembliesPage(ctx)
		return
	}
	s.assemblies.view(ctx)
}

func (s *shellState) panelSettings(ctx *ui.Context) {
	if s.settings == nil {
		s.ensureSettings()
		skeletonSettingsPage(ctx)
		return
	}
	s.settings.view(ctx)
}
