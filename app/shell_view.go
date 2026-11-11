package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) view(ctx *ui.Context) {
	applyTheme(ctx)
	t := gwtheme.Of(ctx)
	if s.board.focus {
		ui.Row(ctx).Fill().Background(t.Window).Children(func() {
			s.rail(ctx)
			ui.Row(ctx).Grow(1).FillHeight().Padding(cardGap).Children(func() {
				s.whiteboard(ctx)
			})
		})
		return
	}
	ui.Row(ctx).Fill().Background(t.Window).Children(func() {
		s.rail(ctx)
		ui.Row(ctx).Grow(1).FillHeight().Padding(cardGap).Gap(cardGap).Children(func() {
			s.conversationPane(ctx)
			s.chatPane(ctx)
			s.whiteboard(ctx)
		})
	})
}

func (s *shellState) rail(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Column(ctx).Width(railWidth).FillHeight().Padding(th.Space(2), th.Space(1)).Gap(th.Space(0.5)).
		AlignItems(ui.Center).Children(func() {
		for _, item := range railItems {
			spec := item
			selected := s.board.lastKind == spec.kind
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
}

func (s *shellState) conversationPane(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	pane := ui.Column(ctx).Width(listWidth).FillHeight().Background(t.Sidebar).Radius(t.Radius.Xl).
		Border(gwtheme.Hairline, t.Border).Clip().Padding(th.Space(2)).Gap(th.Space(0.5))
	kit.Elevate(ctx, pane, gwtheme.ShadowXs)
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
	row := kit.SidebarItem(ctx, kit.SidebarItemOpts{
		Selected: selected,
		OnClick: func() {
			if s.supervisorID != "" {
				s.selectConversation(s.supervisorID)
			}
		},
	})
	row.Label("main agent")
	row.Children(func() {
		ui.Icon(ctx, iconBird).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Foreground)
		kit.Text(ctx, "main agent", t.Text.Base).FontWeight(600).TextColor(t.Foreground).Grow(1).SingleLine()
		ui.Spacer(ctx)
		kit.StatusDot(ctx, kit.OK)
	})
	row.Margin(0, 0, th.Space(1.5), 0)
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
	t, th := gwtheme.Of(ctx), ctx.Theme()
	pane := kit.Panel(ctx, t.Radius.Xl).Grow(1).MinWidth(300).FillHeight()
	pane.Children(func() {
		active := s.active()
		if active == nil {
			kit.Text(ctx, "从左侧选择一个项目", t.Text.Base).TextColor(t.Muted).Padding(th.Space(5))
			return
		}
		active.view(ctx)
	})
}
