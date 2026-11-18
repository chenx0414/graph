package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// collabCardLimit bounds how many agent messages the collaboration card lists
// at once; the count above the list tells how many are still waiting.
const collabCardLimit = 6

// collabMessage reports whether the message comes from another agent (a project
// supervisor, a peer or a sub-agent) rather than from the user. Those messages
// travel through the same conversation so the master agent can answer them, but
// they are internal cooperation, not something the user said.
func collabMessage(message transcriptMessage) bool {
	switch message.Data.Source.Kind {
	case "agent", "supervisor", "peer":
		return true
	}
	return false
}

// splitCollabMessages splits the transcript into what the user said (and the
// assistant answered) and the agent to agent messages the collaboration card
// owns.
func splitCollabMessages(messages []transcriptMessage) (spoken, collab []transcriptMessage) {
	for _, message := range messages {
		if collabMessage(message) {
			collab = append(collab, message)
			continue
		}
		spoken = append(spoken, message)
	}
	return spoken, collab
}

// collabMessageText returns the sender label and the readable body of an agent
// message. The envelope (the "[来自项目主管的通知]" tag and the bookkeeping
// lines under it) stays out of sight: the card shows what was said.
func collabMessageText(message transcriptMessage) (label, detail string) {
	text := strings.TrimSpace(message.Text)
	tagged := false
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "[来自项目主管的通知]") {
			tagged = true
			continue
		}
		if tagged {
			if content, ok := trimmedContentLine(trimmed); ok {
				return "项目主管通知", content
			}
			continue
		}
		return "Agent 消息", trimmed
	}
	if tagged {
		return "项目主管通知", ""
	}
	return "Agent 消息", ""
}

func trimmedContentLine(line string) (string, bool) {
	for _, prefix := range []string{"内容:", "内容：", "内容 :"} {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix)), true
		}
	}
	return "", false
}

// collabMessageMeta names who sent the message to which conversation, so the
// card reads like a cross agent timeline instead of a chat bubble.
func collabMessageMeta(message transcriptMessage, label string) string {
	meta := []string{label}
	if summary := strings.TrimSpace(message.Data.Source.Summary); summary != "" && summary != "update" {
		meta = append(meta, summary)
	}
	if from := strings.TrimSpace(message.Data.Source.ConversationID); from != "" {
		meta = append(meta, from)
	}
	return strings.Join(meta, " · ")
}

func (c *chatState) collabCard(ctx *ui.Context, messages []transcriptMessage) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	open := c.expanded["collab"]
	card := ui.Column(ctx).FillWidth().Padding(th.Space(1.5), th.Space(2)).Radius(t.Radius.Md).
		Border(gwtheme.Hairline, t.Border).Background(t.Card).Gap(th.Space(1))
	card.Children(func() {
		header := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Label("跨 Agent 协作").Focusable()
		header.OnClick(func() {
			c.expanded["collab"] = !open
			c.frame()
		})
		header.Children(func() {
			chevron := ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
			if open {
				chevron.Rotate(180)
			}
			ui.Icon(ctx, iconNetwork).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
			kit.Text(ctx, "跨 Agent 协作", t.Text.Xs).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, strconv.Itoa(len(messages))+" 条", t.Text.Xs).TextColor(t.Muted).SingleLine()
		})
		if !open {
			return
		}
		shown := messages
		if len(shown) > collabCardLimit {
			shown = shown[len(shown)-collabCardLimit:]
		}
		for _, message := range shown {
			row := message
			label, detail := collabMessageText(row)
			line := ui.Column(ctx).FillWidth().Gap(th.Space(0.25)).Children(func() {
				ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
					kit.Text(ctx, collabMessageMeta(row, label), t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
					if row.CreatedAt > 0 {
						kit.Text(ctx, messageClock(row.CreatedAt), t.Text.Xs).TextColor(t.Muted)
					}
				})
				if detail != "" {
					kit.Text(ctx, detail, t.Text.Sm).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				}
			})
			_ = line
		}
		if hidden := len(messages) - len(shown); hidden > 0 {
			kit.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 条协作消息未列出", t.Text.Xs).TextColor(t.Muted).SingleLine()
		}
	})
}
