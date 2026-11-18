package main

import (
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// Layout numbers mirror the DSH cross-agent swimlane card. The left rail holds
// the agent identity; the right track is the time domain. Values are in DIPs,
// which map 1:1 to the CSS pixels in the DSH source (see the comparison note
// in UX_ROUND2_REPORT.md).
const (
	collabRailWidth  = 196
	collabTimeWidth  = 66
	collabLaneHeight = 36
	collabChipGap    = 4
)

// collabLinksFromEvents derives sender -> receiver links straight from the
// time-ordered events. It is deliberately independent of model.Links: the
// filter path rebuilds links from the surviving events, and deriving them here
// keeps the arrows correct for a searched view as well.
func collabLinksFromEvents(events []collabSwimlaneEvent) []collabSwimlaneLink {
	index := map[string]int{}
	links := make([]collabSwimlaneLink, 0)
	for _, event := range events {
		from := strings.TrimSpace(event.From)
		to := strings.TrimSpace(event.To)
		if from == "" || to == "" {
			continue
		}
		key := from + ">" + to
		if at, ok := index[key]; ok {
			links[at].Count++
			continue
		}
		index[key] = len(links)
		links = append(links, collabSwimlaneLink{From: from, To: to, Count: 1})
	}
	sort.SliceStable(links, func(i, j int) bool {
		if links[i].Count != links[j].Count {
			return links[i].Count > links[j].Count
		}
		if links[i].From != links[j].From {
			return links[i].From < links[j].From
		}
		return links[i].To < links[j].To
	})
	return links
}

func collabLaneIndex(model collabSwimlane) map[string]int {
	index := make(map[string]int, len(model.Lanes))
	for at, lane := range model.Lanes {
		index[lane.ID] = at
	}
	return index
}

// collabDisplayName resolves an agent id to the name its lane shows, so link
// rows and lane headers never disagree (a supervisor lane reads
// "项目主管通知", not its bare conversation id). It falls back to the derived
// short name when no lane carries the id.
func collabDisplayName(model collabSwimlane, id string) string {
	if id == "" {
		return collabAgentName(id)
	}
	for _, lane := range model.Lanes {
		if lane.ID == id && lane.Name != "" {
			return lane.Name
		}
	}
	return collabAgentName(id)
}

// renderCollabSwimlane draws the DSH-style collaboration card: a header with
// record/lane counts, search and the earliest/latest stamps, one lane per
// participating agent, a time-ordered event track in each lane, sender ->
// receiver arrows and a click-to-expand detail.
func (c *chatState) renderCollabSwimlane(ctx *ui.Context, messages []transcriptMessage) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	open := c.expanded["collab"]

	model := buildCollabSwimlane(messages, c.active)
	shown := filterCollabSwimlane(model, c.collabQuery)
	links := collabLinksFromEvents(shown.Events)

	card := ui.Column(ctx).FillWidth().Padding(th.Space(1.5), th.Space(2)).Radius(t.Radius.Md).
		Border(gwtheme.Hairline, t.Border).Background(t.Card).Gap(th.Space(1))
	card.Children(func() {
		c.collabSwimlaneHeader(ctx, t, model, shown, open)
		if !open {
			return
		}
		if shown.Records == 0 {
			c.collabSwimlaneEmpty(ctx, t, len(messages) > 0)
			return
		}
		c.collabSwimlaneBody(ctx, t, shown, links)
	})
}

func (c *chatState) collabSwimlaneHeader(ctx *ui.Context, t gwtheme.Tokens, model, shown collabSwimlane, open bool) {
	th := ctx.Theme()
	head := ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center).Label("跨 Agent 协作").Focusable()
	head.OnClick(func() {
		c.expanded["collab"] = !open
		c.frame()
	})
	head.Children(func() {
		chevron := ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
		if open {
			chevron.Rotate(180)
		}
		ui.Icon(ctx, iconNetwork).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
		kit.Text(ctx, "跨 Agent 协作", t.Text.Xs).TextColor(t.Muted).SingleLine()
		kit.Text(ctx, strconv.Itoa(model.Records)+" 条", t.Text.Xs).TextColor(t.Muted).SingleLine()
		kit.Text(ctx, strconv.Itoa(model.LaneCount())+" 泳道", t.Text.Xs).TextColor(t.Muted).SingleLine()
		ui.Spacer(ctx)
		if shown.Records != model.Records {
			kit.Text(ctx, "筛出 "+strconv.Itoa(shown.Records)+" 条", t.Text.Xs).TextColor(t.Primary).SingleLine()
		}
	})
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
		input := kit.Input(ctx, &c.collabQuery, kit.InputOpts{Placeholder: "搜索协作记录…", Flat: true})
		input.Grow(1)
		if model.Earliest > 0 {
			kit.Text(ctx, "最早 "+relativeTimeFromMillis(model.Earliest, ctx.Now()), t.Text.Xs).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, "最新 "+relativeTimeFromMillis(model.Latest, ctx.Now()), t.Text.Xs).TextColor(t.Muted).SingleLine()
		}
	})
}

func (c *chatState) collabSwimlaneEmpty(ctx *ui.Context, t gwtheme.Tokens, filteredOut bool) {
	th := ctx.Theme()
	ui.Box(ctx).FillWidth().Padding(th.Space(2), th.Space(1)).Children(func() {
		if filteredOut {
			kit.Text(ctx, "没有匹配的协作记录。", t.Text.Xs).TextColor(t.Muted).SingleLine()
			return
		}
		kit.Text(ctx, "还没有协作记录", t.Text.Xs).TextColor(t.Muted).SingleLine()
	})
}

func (c *chatState) collabSwimlaneBody(ctx *ui.Context, t gwtheme.Tokens, model collabSwimlane, links []collabSwimlaneLink) {
	th := ctx.Theme()
	// Axis: the left rail names the agent columns, the right track is the
	// time domain with its earliest/latest endpoints.
	ui.Row(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
		ui.Box(ctx).Width(collabRailWidth).Height(th.Space(5)).PaddingX(th.Space(1)).
			Center().Children(func() {
			kit.Text(ctx, "Agent / 模型 / 开销", t.Text.Xs).TextColor(t.Muted).SingleLine()
		})
		ui.Box(ctx).Grow(1).Height(th.Space(5)).PaddingX(th.Space(1)).Children(func() {
			kit.Text(ctx, relativeTimeFromMillis(model.Earliest, ctx.Now()), t.Text.Xs).TextColor(t.Muted).SingleLine()
			ui.Spacer(ctx)
			kit.Text(ctx, relativeTimeFromMillis(model.Latest, ctx.Now()), t.Text.Xs).TextColor(t.Muted).SingleLine()
		})
	})

	for _, lane := range model.Lanes {
		c.collabLaneRow(ctx, t, model, lane)
	}

	if len(links) > 0 {
		c.collabLinkSection(ctx, t, model, links)
	}
	c.collabEventDetail(ctx, t, model)
}

func (c *chatState) collabLaneRow(ctx *ui.Context, t gwtheme.Tokens, model collabSwimlane, lane collabSwimlaneLane) {
	th := ctx.Theme()
	row := ui.Row(ctx).FillWidth().Height(collabLaneHeight).Gap(th.Space(1))
	row.Children(func() {
		// Left rail: avatar + name + model + token/cost + task/event counts.
		rail := ui.Row(ctx).Width(collabRailWidth).Height(collabLaneHeight).Gap(th.Space(1)).
			PaddingX(th.Space(1)).AlignItems(ui.Center)
		if row.Hovered() {
			rail.Background(t.Hover)
		}
		rail.Children(func() {
			avatar := ui.Box(ctx).Size(th.Space(5), th.Space(5)).Radius(t.Radius.Sm).Background(t.Hover).Center()
			avatar.Children(func() {
				kit.Text(ctx, lane.Initial, t.Text.Xs).FontWeight(600).TextColor(t.Foreground).SingleLine()
			})
			meta := ui.Column(ctx).Grow(1).Shrink(1).Gap(1).Children(func() {
				kit.Text(ctx, lane.Name, t.Text.Xs).FontWeight(600).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				parts := []string{}
				if lane.Model != "" {
					parts = append(parts, lane.Model)
				}
				if lane.Tokens > 0 {
					parts = append(parts, formatTokensCompact(lane.Tokens))
				}
				if lane.Cost > 0 {
					parts = append(parts, "$"+strconv.FormatFloat(lane.Cost, 'f', 2, 64))
				}
				parts = append(parts, strconv.Itoa(lane.Tasks)+" 任务 / "+strconv.Itoa(lane.Events)+" 事件")
				kit.Text(ctx, strings.Join(parts, " · "), 10).TextColor(t.Muted).SingleLine().Ellipsis("…")
			})
			_ = meta
		})

		// Right track: the agent's events, in time order, placed on the lane.
		track := ui.Row(ctx).Grow(1).Height(collabLaneHeight).AlignItems(ui.Center).Gap(collabChipGap)
		track.Children(func() {
			span := model.Latest - model.Earliest
			for _, event := range model.Events {
				if event.LaneID != lane.ID {
					continue
				}
				event := event
				if span > 0 {
					fraction := float64(event.CreatedAt-model.Earliest) / float64(span)
					if fraction < 0 {
						fraction = 0
					}
					if fraction > 1 {
						fraction = 1
					}
					ui.Box(ctx).Width(float32(fraction) * collabTimeWidth)
				}
				// DSH's step row keeps a 2px inset bar on the left marking the
				// owning lane; the chip opens with that bar as its own child.
				chip := ui.Row(ctx).Height(th.Space(5)).Padding(th.Space(0.5), th.Space(1), th.Space(0.5), th.Space(0.5)).
					Radius(t.Radius.Sm).Background(t.Hover).AlignItems(ui.Center).Gap(th.Space(0.5)).
					Label(event.Text).Focusable()
				chip.OnClick(func() {
					c.collabEventID = event.ID
					c.frame()
				})
				chip.Children(func() {
					ui.Box(ctx).Width(2).Height(th.Space(3)).Radius(1).Background(t.Primary)
					clock := relativeTimeFromMillis(event.CreatedAt, ctx.Now())
					if clock != "" {
						kit.Text(ctx, clock, 10).Font(gwtheme.MonoFont).TextColor(t.Muted).SingleLine()
					}
					kit.Text(ctx, "→ "+collabDisplayName(model, event.To), 10).TextColor(t.Primary).SingleLine()
					kit.Text(ctx, event.Text, t.Text.Xs).TextColor(t.Foreground).SingleLine().Ellipsis("…").MaxWidth(260)
				})
			}
		})
	})
	ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border)
}

// collabLinkSection renders the sender -> receiver arrows. Each link is both a
// drawn connector (a small canvas strip) and a readable text row, so the arrow
// survives the headless tester and assistive tech.
func (c *chatState) collabLinkSection(ctx *ui.Context, t gwtheme.Tokens, model collabSwimlane, links []collabSwimlaneLink) {
	th := ctx.Theme()
	ui.Row(ctx).FillWidth().Padding(th.Space(1), 0, 0, 0).Children(func() {
		kit.Text(ctx, "协作连线", t.Text.Xs).FontWeight(600).TextColor(t.Muted).SingleLine()
		kit.Text(ctx, strconv.Itoa(len(links))+" 条", t.Text.Xs).TextColor(t.Muted).SingleLine()
	})
	index := collabLaneIndex(model)
	strip := ui.Box(ctx).FillWidth().Height(float32(len(links))*th.Space(4) + th.Space(1))
	strip.Draw(func(p *ui.Painter, r ui.Rect) {
		rowH := th.Space(4)
		startX := r.X + collabRailWidth
		endX := r.X + r.W - th.Space(2)
		if endX <= startX {
			return
		}
		for at, link := range links {
			y := r.Y + th.Space(1) + float32(at)*rowH + rowH/2
			fromLane, hasFrom := index[link.From]
			toLane, hasTo := index[link.To]
			if !hasFrom || !hasTo {
				continue
			}
			color := t.Primary.Alpha(0.8)
			mid := startX + (endX-startX)*0.5
			p.Line(startX, y, mid, y, 1, color)
			p.Line(mid, y, mid, y+float32(toLane-fromLane)*4, 1, color)
			p.Line(mid, y+float32(toLane-fromLane)*4, endX, y+float32(toLane-fromLane)*4, 1, color)
			// arrow head at the receiver end
			p.Line(endX-5, y+float32(toLane-fromLane)*4-3, endX, y+float32(toLane-fromLane)*4, 1, color)
			p.Line(endX-5, y+float32(toLane-fromLane)*4+3, endX, y+float32(toLane-fromLane)*4, 1, color)
		}
	})
	for _, link := range links {
		link := link
		from, to := collabDisplayName(model, link.From), collabDisplayName(model, link.To)
		line := ui.Row(ctx).FillWidth().Height(th.Space(4)).Gap(th.Space(1)).AlignItems(ui.Center).
			Label(from + " → " + to).Focusable()
		line.OnClick(func() {
			c.collabEventID = ""
			c.frame()
		})
		line.Children(func() {
			kit.Text(ctx, from, t.Text.Xs).TextColor(t.Foreground).SingleLine()
			kit.Text(ctx, "→", t.Text.Sm).TextColor(t.Primary).SingleLine()
			kit.Text(ctx, to, t.Text.Xs).TextColor(t.Foreground).SingleLine()
			kit.Text(ctx, strconv.Itoa(link.Count)+" 次", t.Text.Xs).TextColor(t.Muted).SingleLine()
		})
	}
}

func (c *chatState) collabEventDetail(ctx *ui.Context, t gwtheme.Tokens, model collabSwimlane) {
	if c.collabEventID == "" {
		return
	}
	var selected *collabSwimlaneEvent
	for at := range model.Events {
		if model.Events[at].ID == c.collabEventID {
			selected = &model.Events[at]
			break
		}
	}
	if selected == nil {
		return
	}
	th := ctx.Theme()
	detail := ui.Column(ctx).FillWidth().Padding(th.Space(1.5), th.Space(2)).Radius(t.Radius.Sm).
		Border(gwtheme.Hairline, t.Border).Background(t.Background).Gap(th.Space(0.5))
	detail.Children(func() {
		ui.Row(ctx).FillWidth().AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, "协作记录 · "+collabDisplayName(model, selected.From)+" → "+collabDisplayName(model, selected.To), t.Text.Xs).
				FontWeight(600).TextColor(t.Foreground).SingleLine().Grow(1)
			clock := relativeTimeFromMillis(selected.CreatedAt, ctx.Now())
			if clock != "" {
				kit.Text(ctx, clock, t.Text.Xs).TextColor(t.Muted).SingleLine()
			}
			if kit.Button(ctx, "收起", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				c.collabEventID = ""
				c.frame()
			}
		})
		kit.Text(ctx, selected.Text, t.Text.Sm).TextColor(t.Foreground)
	})
}

func formatTokensCompact(tokens int64) string {
	switch {
	case tokens >= 1_000_000:
		return strconv.FormatFloat(float64(tokens)/1_000_000, 'f', 1, 64) + "M tok"
	case tokens >= 1_000:
		return strconv.FormatFloat(float64(tokens)/1_000, 'f', 1, 64) + "k tok"
	}
	return strconv.FormatInt(tokens, 10) + " tok"
}
