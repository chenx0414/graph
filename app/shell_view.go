package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) view(ctx *ui.Context) {
	s.updates.drain()
	applyTheme(ctx)
	t := gwtheme.Of(ctx)
	shell := ui.Row(ctx).Fill().Background(pageBackdrop(t))
	shell.Children(func() {
		s.rail(ctx)
		ui.Column(ctx).Grow(1).FillHeight().Children(func() {
			s.titleBand(ctx)
			ui.Row(ctx).Grow(1).FillWidth().Padding(0, cardGap, cardGap, ctx.Theme().Space(1.25)).Children(func() {
				card := ui.Row(ctx).Grow(1).FillHeight().Background(t.Background).
					Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).Clip().Label("主区域卡片")
				kit.Elevate(ctx, card, shellShadow)
				card.Children(func() {
					s.conversationPane(ctx)
					s.columnDivider(ctx)
					s.chatPane(ctx)
					s.columnDivider(ctx)
					s.whiteboard(ctx)
				})
			})
		})
	})
	s.archiveConfirmView(ctx)
}

func titleBandHeight(ctx *ui.Context) float32 {
	if bar := ctx.TitleBar(); bar.Height > 0 {
		return float32(bar.Height)
	}
	return bandHeight
}

func (s *shellState) titleBand(ctx *ui.Context) {
	th := ctx.Theme()
	band := ui.Row(ctx).FillWidth().Height(titleBandHeight(ctx)).Padding(0, cardGap, 0, th.Space(1.25)).AlignItems(ui.Center)
	band.Children(func() {
		listTitle := ui.Row(ctx).Width(listWidth).FillHeight().Padding(0, th.Space(3), 0, th.Space(3)).
			AlignItems(ui.Center).Label("会话列表标题").DragWindow()
		listTitle.Children(func() {
			ui.Spacer(ctx).Grow(1)
		})
		ui.Box(ctx).Width(gwtheme.Stroke)
		chatTitle := ui.Row(ctx).Grow(1).FillHeight().AlignItems(ui.Center).Label("对话标题").DragWindow()
		chatTitle.Children(func() {
			ui.Box(ctx).Width(th.Space(4))
			title := ""
			if active := s.active(); active != nil && active.active != "" {
				title = s.titleOf(active.active)
			}
			if title != "" {
				kit.Text(ctx, title, gwtheme.Of(ctx).Text.Lg).FontWeight(600).SingleLine().Ellipsis("…").Grow(1).
					Translate(0, -1.5).Label("对话标题名")
			}
			ui.Box(ctx).Width(th.Space(4))
		})
		ui.Box(ctx).Width(gwtheme.Stroke)
		ui.Row(ctx).Grow(1.35).FillHeight().Children(func() {
			s.boardTabBar(ctx)
		})
	})
}

func (s *shellState) columnDivider(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	ui.Box(ctx).Width(gwtheme.Stroke).FillHeight().Background(columnLine(t))
}

func (s *shellState) rail(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Column(ctx).Width(railWidth).FillHeight().Children(func() {
		ui.Box(ctx).FillWidth().Height(th.Space(11)).DragWindow()
		ui.Column(ctx).Grow(1).Padding(th.Space(3.5), 0, th.Space(2), cardGap).Gap(th.Space(3)).
			AlignItems(ui.Center).Translate(-1.5, 0).Children(func() {
			for _, item := range railItems {
				spec := item
				selected := s.activeBoardKind() == spec.kind
				color := t.Muted
				button := ui.Box(ctx).Size(th.Space(8), th.Space(8)).Radius(t.Radius.Lg).Center().
					Label(spec.label).Focusable()
				button.OnClick(func() { s.openModule(spec.kind) })
				ui.TooltipBase(ctx, button, func(tip ui.Element) {
					tip.AttachTo(button, ui.AnchorRight, ui.AnchorLeft).MarginStart(th.Space(1.5)).
						Padding(th.Space(1), th.Space(2)).Radius(t.Radius.Md).Background(t.Foreground)
					tip.Children(func() {
						kit.Text(ctx, spec.label, t.Text.Lg).TextColor(t.Background).FontWeight(600)
					})
				})
				switch {
				case selected:
					button.Background(t.SidebarSelected)
					color = t.Foreground
				case button.Hovered():
					button.Background(t.HoverTint)
					color = t.Foreground
				}
				button.Children(func() {
					ui.Icon(ctx, spec.icon).Size(th.Space(5), th.Space(5)).TextColor(color)
				})
			}
		})
	})
}

func (s *shellState) conversationPane(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	pane := ui.Column(ctx).Width(listWidth).FillHeight().Background(t.Sidebar).
		Padding(th.Space(2), th.Space(2), th.Space(2), th.Space(2)).Gap(th.Space(0.5))
	pane.Children(func() {
		s.mainAgentCard(ctx)
		if s.status != "" && (len(s.conversations) == 0 || !skeletonLoadingStatus(s.status)) {
			if len(s.conversations) == 0 && skeletonLoadingStatus(s.status) {
				skeletonSidebarRows(ctx, 6)
			} else {
				kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted).Padding(th.Space(2), th.Space(1))
			}
		}
		s.conversationList(ctx)
	})
}

func (s *shellState) mainAgentCard(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	selected := s.supervisorID != "" && s.activeID == s.supervisorID
	row := ui.Row(ctx).FillWidth().Height(th.Space(11)).Padding(0, th.Space(2), 0, th.Space(2)).
		Gap(th.Space(2)).AlignItems(ui.Center).Radius(t.Radius.Xl).
		Border(gwtheme.Hairline, t.Border).Background(t.HoverTint).Focusable().Label("main agent 会话")
	row.Justify(ui.Center)
	open := func() {
		if s.supervisorID != "" {
			s.selectConversation(s.supervisorID)
			return
		}
		go s.startMainAgent()
	}
	row.OnClick(open)
	switch {
	case selected && row.Hovered():
		row.Background(t.HoverTint.Alpha(2.25))
	case selected:
		row.Background(t.HoverTint.Alpha(1.75))
	case row.Hovered():
		row.Background(t.Hover)
	}
	row.Children(func() {
		octoLoader(ctx)
		name := ui.Row(ctx).Label("main agent 名称").Focusable()
		name.OnClick(open)
		name.Children(func() {
			kit.Text(ctx, "Main Agent", t.Text.Lg).FontWeight(600).TextColor(t.Foreground)
		})
	})
	kit.Elevate(ctx, row, gwtheme.ShadowSm)
	row.Margin(0, 0, th.Space(1), 0)
	kit.Separator(ctx, false).Margin(0, 0, th.Space(1.5), 0)
}

func (s *shellState) conversationList(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	// Render one snapshot of the list: the key function and the row builder then
	// agree on the same slice even if a poll lands between two frames.
	conversations := s.conversations
	s.list.Key = func(index int) any {
		if index < 0 || index >= len(conversations) {
			return index
		}
		return conversations[index].ID
	}
	fade := ui.Box(ctx).Grow(1)
	fade.Children(func() {
		ui.List(ctx, &s.list, len(conversations), func(index int) {
			conversation := conversations[index]
			label := s.titleOf(conversation.ID)
			selected := conversation.ID == s.activeID
			opts := kit.SidebarItemOpts{Selected: selected}
			if !selected {
				id := conversation.ID
				opts.OnClick = func() { go s.selectConversation(id) }
			}
			stack := ui.Box(ctx).FillWidth()
			stack.Children(func() {
				row := kit.SidebarItem(ctx, opts)
				row.FillWidth()
				row.Label(label)
				row.Children(func() {
					content := ui.Row(ctx).Grow(1).Shrink(1).MinWidth(0).Gap(th.Space(1.5)).AlignItems(ui.Center)
					content.MaskLinearGradient(ui.LinearGradient{Angle: 90, Stops: []ui.GradientStop{
						{Color: ui.RGB(0, 0, 0), At: 0},
						{Color: ui.RGB(0, 0, 0), At: 0.84},
						{Color: ui.Transparent, At: 1},
					}}).Clip()
					content.Children(func() {
						ui.Icon(ctx, iconFolder).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
						kit.Text(ctx, label, t.Text.Lg).FontWeight(500).TextColor(t.Foreground).Grow(1).Shrink(1).MinWidth(0).SingleLine().Ellipsis("…")
						if conversation.ArchivedAtPresent() || conversation.ProjectArchived() {
							kit.Text(ctx, "已归档", t.Text.Xs).TextColor(t.Muted)
						}
					})
				})
				if conversation.ProjectID != "" && !conversation.ArchivedAtPresent() && !conversation.ProjectArchived() && stack.Hovered() {
					button := kit.IconButton(ctx, iconArchive, "归档项目 "+label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
					button.Absolute().Top(th.Space(2)).Right(th.Space(1))
					button.OnClick(func() { go s.requestArchive(conversation.ProjectID, label) })
				}
			})
			stack.Margin(0, 0, th.Space(0.5), 0)
		}).Grow(1)
	})
}

func (s *shellState) chatPane(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	pane := ui.Column(ctx).Grow(1).MinWidth(300).FillHeight().Background(t.Background)
	pane.Children(func() {
		active := s.active()
		if active == nil {
			if !s.dataReady.Load() {
				skeletonChatTranscript(ctx)
				return
			}
			kit.Text(ctx, "从左侧选择一个项目", t.Text.Base).TextColor(t.Muted).Padding(ctx.Theme().Space(5))
			return
		}
		active.view(ctx)
	})
}

func (s *shellState) whiteboard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	column := ui.Column(ctx).Grow(1.35).MinWidth(320).FillHeight().Background(t.Sidebar)
	column.Children(func() {
		s.boardPageView(ctx)
	})
}
