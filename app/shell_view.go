package main

import "github.com/egoist/mygo/ui"

func (s *shellState) view(ctx *ui.Context) {
	ctx.SetTheme(graphTheme)
	t := ctx.Theme()
	if s.board.focus {
		ui.Row(ctx).Fill().Background(t.Background).Children(func() {
			s.rail(ctx)
			ui.Row(ctx).Grow(1).FillHeight().Padding(cardGap).Children(func() {
				s.whiteboard(ctx)
			})
		})
		return
	}
	ui.Row(ctx).Fill().Background(t.Background).Children(func() {
		s.rail(ctx)
		ui.Row(ctx).Grow(1).FillHeight().Padding(cardGap).Gap(cardGap).Children(func() {
			s.conversationPane(ctx)
			s.chatPane(ctx)
			s.whiteboard(ctx)
		})
	})
}

func (s *shellState) rail(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Column(ctx).Width(railWidth).FillHeight().Padding(14, 8).Gap(6).AlignItems(ui.Center).Children(func() {
		for _, item := range railItems {
			spec := item
			selected := s.board.lastKind == spec.kind
			color := t.TextMuted
			if selected {
				color = t.Accent
			}
			button := ui.Box(ctx).Size(42, 42).Radius(13).Center().Label(spec.label).Tooltip(spec.label).Focusable()
			button.OnClick(func() { s.openModule(spec.kind) })
			if selected {
				button.Background(t.Accent.Alpha(0.13))
			} else {
				button.Background(ui.Transparent)
			}
			button.Children(func() {
				ui.Icon(ctx, spec.icon).FontSize(20).TextColor(color)
			})
		}
	})
}

func (s *shellState) conversationPane(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Column(ctx).Width(listWidth).FillHeight().Background(t.Surface).Radius(cardRadius).Border(1, t.Border).
		Shadow(0, 10, 28, 0, cardShadow).Clip().Padding(10).Gap(8).Children(func() {
		s.mainAgentCard(ctx)
		if s.status != "" && len(s.conversations) == 0 {
			ui.Text(ctx, s.status).FontSize(12).TextColor(t.TextMuted).Padding(6, 4)
		}
		s.conversationList(ctx)
	})
}

func (s *shellState) mainAgentCard(ctx *ui.Context) {
	t := ctx.Theme()
	card := ui.Box(ctx).FillWidth().Height(56).Radius(14).Center().Label("main agent").Focusable()
	card.Gradient(t.Accent.Alpha(0.14), t.Accent.Alpha(0.02), 135)
	card.Border(1.5, t.Accent.Alpha(0.55))
	card.OnClick(func() {
		if s.supervisorID != "" {
			s.selectConversation(s.supervisorID)
		}
	})
	card.Children(func() {
		ui.Text(ctx, "main agent").FontSize(16).FontWeight(600).TextColor(t.Text)
	})
}

func (s *shellState) conversationList(ctx *ui.Context) {
	s.list.Key = func(index int) any { return s.conversations[index].ID }
	ui.List(ctx, &s.list, len(s.conversations), func(index int) {
		conversation := s.conversations[index]
		s.conversationCard(ctx, conversation)
	}).Grow(1)
}

func (s *shellState) conversationCard(ctx *ui.Context, conversation conversationSummary) {
	t := ctx.Theme()
	selected := conversation.ID == s.activeID
	label := s.titleOf(conversation.ID)
	card := ui.Box(ctx).FillWidth().Height(44).Radius(12).Center().Label(label).Focusable()
	card.Background(t.Surface)
	card.Border(1, t.Border)
	if selected {
		card.Gradient(t.Accent.Alpha(0.16), t.Accent.Alpha(0.03), 135)
		card.Border(1.5, t.Accent)
	}
	if conversation.ArchivedAtPresent() {
		card.Opacity(0.65)
	}
	card.OnClick(func() { go s.selectConversation(conversation.ID) })
	card.Children(func() {
		color := t.Text
		if selected {
			color = t.Accent
		}
		ui.Text(ctx, label).FontSize(13).TextColor(color).SingleLine().Ellipsis("…")
	})
}

func (s *shellState) chatPane(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Column(ctx).Grow(1).MinWidth(300).FillHeight().Background(t.Surface).Radius(cardRadius).Border(1, t.Border).
		Shadow(0, 10, 28, 0, cardShadow).Clip().Children(func() {
		active := s.active()
		if active == nil {
			ui.Text(ctx, "从左侧选择一个项目").Padding(20).TextColor(t.TextMuted)
			return
		}
		active.view(ctx)
	})
}
