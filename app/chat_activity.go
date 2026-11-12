package main

import (
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (c *chatState) toolRow(ctx *ui.Context, run transcriptRun) {
	t := gwtheme.Of(ctx)
	key := runKey(run)
	ui.Column(ctx).Gap(2).Children(func() {
		label := workedLabel(run, c.expanded[key])
		if kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).TextColor(t.Muted).Justify(ui.Start).Clicked() {
			c.expanded[key] = !c.expanded[key]
		}
		if !c.expanded[key] {
			return
		}
		for _, message := range run.messages {
			kit.Text(ctx, toolLine(message), t.Text.Xs).TextColor(t.Muted)
		}
	})
}

func (c *chatState) messageRow(ctx *ui.Context, message transcriptMessage) {
	mine := message.Role == "user"
	if !mine {
		th := ctx.Theme()
		ui.Column(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
			c.markdownMessage(ctx, message)
			c.messageMeta(ctx, message, false)
		})
		return
	}
	ui.Row(ctx).FillWidth().Children(func() {
		ui.Spacer(ctx)
		ui.Column(ctx).MaxWidthPercent(84).Gap(ctx.Theme().Space(1)).Children(func() {
			c.bubble(ctx, message)
			c.messageMeta(ctx, message, true)
		})
	})
}

func (c *chatState) markdownMessage(ctx *ui.Context, message transcriptMessage) {
	if messageStreaming(message) {
		markdown.Stream(ctx, message.Text, &c.md)
		return
	}
	markdown.View(ctx, message.Text, &c.md)
}

func (c *chatState) bubble(ctx *ui.Context, message transcriptMessage) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bubble := ui.Column(ctx).Padding(th.Space(2.5), th.Space(3.5)).Radius(t.Radius.Xl).Gap(th.Space(1)).Clip().
		Border(gwtheme.Hairline, t.Border).Background(userBubble(t))
	bubble.Children(func() {
		if messageQueued(message) {
			if kit.Button(ctx, "撤销这条排队消息", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				go c.cancelQueued(message.ID)
			}
		}
		if messageStreaming(message) {
			markdown.Stream(ctx, message.Text, &c.md)
		} else {
			markdown.View(ctx, message.Text, &c.md)
		}
	})
}

func (c *chatState) messageMeta(ctx *ui.Context, message transcriptMessage, mine bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	row := ui.Row(ctx).Gap(th.Space(1)).AlignItems(ui.Center)
	if mine {
		row.Justify(ui.End)
	} else {
		row.Justify(ui.Start)
	}
	row.Children(func() {
		if message.CreatedAt > 0 {
			kit.Text(ctx, messageClock(message.CreatedAt), t.Text.Xs).TextColor(t.Muted)
		}
		text := message.Text
		if iconAction(ctx, iconCopy, "复制", false, 5, func() { copyMessage(text) }).Clicked() {
		}
		if mine {
			return
		}
		iconAction(ctx, iconThumbUp, "赞", false, 5, nil)
		iconAction(ctx, iconThumbDown, "踩", false, 5, nil)
		iconAction(ctx, iconVolume, "朗读", false, 5, nil)
		iconAction(ctx, iconMore, "更多", false, 5, nil)
	})
}

func workedLabel(run transcriptRun, expanded bool) string {
	marker := "▸"
	if expanded {
		marker = "▾"
	}
	parts := []string{}
	if worked := runWorked(run); worked != "" {
		parts = append(parts, "已用时 "+worked)
	}
	parts = append(parts, strconv.Itoa(len(run.messages))+" 次调用")
	if strings.Contains(runSummary(run), "进行中") {
		parts = append(parts, "进行中")
	}
	return marker + " " + strings.Join(parts, " · ")
}

func runWorked(run transcriptRun) string {
	if len(run.messages) < 2 {
		return ""
	}
	start := run.messages[0].CreatedAt
	end := run.messages[len(run.messages)-1].CreatedAt
	if start <= 0 || end <= start {
		return ""
	}
	return workedFor(time.Duration(end-start) * time.Millisecond)
}

func workedFor(elapsed time.Duration) string {
	seconds := int64(elapsed / time.Second)
	if seconds <= 0 {
		return "<1 秒"
	}
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	rest := seconds % 60
	switch {
	case hours > 0:
		return strconv.FormatInt(hours, 10) + " 小时 " + strconv.FormatInt(minutes, 10) + " 分 " + strconv.FormatInt(rest, 10) + " 秒"
	case minutes > 0:
		return strconv.FormatInt(minutes, 10) + " 分 " + strconv.FormatInt(rest, 10) + " 秒"
	}
	return strconv.FormatInt(rest, 10) + " 秒"
}
