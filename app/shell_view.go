package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) view(ctx *ui.Context) {
	applyTheme(ctx)
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).Fill().Background(pageBackdrop(t)).Children(func() {
		s.rail(ctx)
		ui.Column(ctx).Grow(1).FillHeight().Children(func() {
			s.titleBand(ctx)
			ui.Box(ctx).FillWidth().Height(th.Space(1))
			ui.Row(ctx).Grow(1).FillWidth().Padding(0, cardGap, cardGap, cardGap).Children(func() {
				card := ui.Row(ctx).Grow(1).FillHeight().Background(t.Background).
					Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).Clip()
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
}

func (s *shellState) titleBand(ctx *ui.Context) {
	th := ctx.Theme()
	muted := gwtheme.Of(ctx).Muted
	band := ui.Row(ctx).FillWidth().Height(bandHeight).Padding(0, cardGap, 0, cardGap).AlignItems(ui.Center)
	band.Children(func() {
		listTitle := ui.Row(ctx).Width(listWidth).FillHeight().Padding(0, th.Space(3), 0, th.Space(3)).
			AlignItems(ui.Center).Label("会话列表标题").DragWindow()
		listTitle.Children(func() {
			ui.Spacer(ctx).Grow(1)
		})
		ui.Box(ctx).Width(gwtheme.Stroke)
		chatTitle := ui.Row(ctx).Grow(1).FillHeight().Padding(0, th.Space(4), 0, th.Space(4)).
			AlignItems(ui.Center).Label("对话标题").DragWindow()
		chatTitle.Children(func() {
			title := "Graph"
			if active := s.active(); active != nil && active.active != "" {
				title = s.titleOf(active.active)
			}
			ui.Icon(ctx, iconChat).Size(gwtheme.Icon, gwtheme.Icon).TextColor(muted)
			kit.Text(ctx, title, gwtheme.Of(ctx).Text.Base).FontWeight(600).SingleLine().Ellipsis("…").Grow(1)
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
		ui.Column(ctx).Grow(1).Padding(0, 0, th.Space(2), 0).Gap(th.Space(0.5)).
			AlignItems(ui.Center).Children(func() {
			for _, item := range railItems {
				spec := item
				selected := s.activeBoardKind() == spec.kind
				color := t.Muted
				button := ui.Box(ctx).Size(th.Space(10), th.Space(10)).Radius(t.Radius.Lg).Center().
					Label(spec.label).Tooltip(spec.label).Focusable()
				button.OnClick(func() { s.openModule(spec.kind) })
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
		if s.status != "" && len(s.conversations) == 0 {
			kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted).Padding(th.Space(2), th.Space(1))
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
	row.OnClick(func() {
		if s.supervisorID != "" {
			s.selectConversation(s.supervisorID)
		}
	})
	switch {
	case selected:
		row.Background(t.SidebarSelected)
	case row.Hovered():
		row.Background(t.Hover)
	}
	row.Children(func() {
		octoLoader(ctx)
		name := ui.Row(ctx).Label("main agent 名称").Focusable()
		name.Children(func() {
			kit.Text(ctx, "main agent", t.Text.Base).FontWeight(600).TextColor(t.Foreground)
		})
	})
	kit.Elevate(ctx, row, gwtheme.ShadowSm)
	row.Margin(0, 0, th.Space(1), 0)
	kit.Separator(ctx, false).Margin(0, 0, th.Space(1.5), 0)
}

func (s *shellState) conversationList(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	s.list.Key = func(index int) any { return s.conversations[index].ID }
	ui.List(ctx, &s.list, len(s.conversations), func(index int) {
		conversation := s.conversations[index]
		label := s.titleOf(conversation.ID)
		selected := conversation.ID == s.activeID
		opts := kit.SidebarItemOpts{Selected: selected}
		if !selected {
			id := conversation.ID
			opts.OnClick = func() { go s.selectConversation(id) }
		}
		row := kit.SidebarItem(ctx, opts)
		row.Label(label)
		row.Children(func() {
			ui.Icon(ctx, iconFolder).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
			kit.Text(ctx, label, t.Text.Base).FontWeight(500).TextColor(t.Foreground).Grow(1).SingleLine().Ellipsis("…")
			if conversation.ArchivedAtPresent() {
				kit.Text(ctx, "已归档", t.Text.Xs).TextColor(t.Muted)
			}
		})
		row.Margin(0, 0, th.Space(0.5), 0)
	}).Grow(1)
}

func (s *shellState) chatPane(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	pane := ui.Column(ctx).Grow(1).MinWidth(300).FillHeight().Background(t.Background)
	pane.Children(func() {
		active := s.active()
		if active == nil {
			kit.Text(ctx, "从左侧选择一个项目", t.Text.Base).TextColor(t.Muted).Padding(ctx.Theme().Space(5))
			return
		}
		active.view(ctx)
	})
}

func (s *shellState) whiteboard(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	column := ui.Column(ctx).Grow(1.35).MinWidth(320).FillHeight().Background(t.Background)
	column.Children(func() {
		s.boardPageView(ctx)
	})
}
