package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type codexActivity struct {
	kind      string
	text      string
	label     string
	command   string
	args      string
	output    string
	failure   string
	failed    bool
	cancelled bool
	key       string
}

func codexActivityLabel(name string) string {
	switch {
	case codexCommandTools[name]:
		return "Shell"
	case codexImageTools[name]:
		return "Image"
	case codexEditTools[name]:
		return "Edit"
	case name == "":
		return "Tool"
	}
	return name
}

var codexCommandTools = map[string]bool{"bash": true, "shell": true, "exec": true, "terminal": true, "run_command": true, "cmd": true}

var codexImageTools = map[string]bool{"view_image": true, "image": true, "screenshot": true, "read_image": true, "computer_screenshot": true}

var codexEditTools = map[string]bool{"apply_patch": true, "edit": true, "write": true, "create_file": true, "str_replace_editor": true, "apply_patch_file": true}

func codexToolPayload(text, tool string) string {
	if index := strings.Index(text, ": "); index >= 0 && index < 48 {
		return strings.TrimSpace(text[index+2:])
	}
	return strings.TrimSpace(text)
}

func codexActivities(run transcriptRun) []codexActivity {
	activities := []codexActivity{}
	commands := []string{}
	argsValues := []string{}
	outputs := []string{}
	failures := []string{}
	failed := false
	key := ""
	flushCommands := func() {
		if len(commands) == 0 {
			return
		}
		activities = append(activities, codexActivity{
			kind: "command", text: "已运行 " + strings.Join(commands, "; "), label: "Shell",
			command: strings.Join(commands, "; "), args: argsText(argsValues), output: strings.Join(outputs, "\n\n"),
			failure: argsText(failures), failed: failed, key: key,
		})
		commands, argsValues, outputs, failures, failed, key = nil, nil, nil, nil, false, ""
	}
	for _, message := range run.messages {
		name := message.Data.Tool
		payload := message.Data.Command
		if payload == "" {
			payload = commandFromArgs(message.Data.Args)
		}
		if payload == "" {
			payload = codexToolPayload(message.Text, name)
		}
		running := messageActive(message)
		cancelled := messagePhaseOf(message) == messagePhaseCancelled
		switch {
		case codexCommandTools[name]:
			if payload == "" {
				continue
			}
			if running {
				flushCommands()
				activities = append(activities, codexActivity{kind: "command", text: "正在运行 " + payload, label: "Shell", command: payload, key: message.Data.ToolCallID})
				continue
			}
			if cancelled {
				flushCommands()
				activities = append(activities, codexActivity{kind: "command", text: "已取消 " + payload, label: "Shell", command: payload, cancelled: true, key: message.Data.ToolCallID})
				continue
			}
			if len(commands) == 0 {
				key = message.Data.ToolCallID
			}
			commands = append(commands, payload)
			if message.Data.Output != "" {
				outputs = append(outputs, message.Data.Output)
			}
			if message.Data.Args != "" {
				argsValues = append(argsValues, message.Data.Args)
			}
			if message.Data.Error {
				failed = true
			}
			if message.Data.ErrorText != "" {
				failures = append(failures, message.Data.ErrorText)
			}
		case codexImageTools[name]:
			flushCommands()
			text := "已查看 1 张图像"
			if running {
				text = "正在查看图像"
			}
			if cancelled {
				text = "已取消查看图像"
			}
			activities = append(activities, codexActivity{kind: "image", text: text, label: "Image", args: message.Data.Args, output: message.Data.Output, cancelled: cancelled, key: message.Data.ToolCallID})
		case codexEditTools[name]:
			flushCommands()
			text := "已编辑文件"
			if payload != "" {
				text = "已编辑 " + payload
			}
			if running {
				text = "正在编辑文件"
				if payload != "" {
					text = "正在编辑 " + payload
				}
			}
			if cancelled {
				text = "已取消编辑"
				if payload != "" {
					text = "已取消编辑 " + payload
				}
			}
			activities = append(activities, codexActivity{kind: "edit", text: text, label: "Edit", command: payload, args: message.Data.Args, output: message.Data.Output, failure: message.Data.ErrorText, failed: message.Data.Error, cancelled: cancelled, key: message.Data.ToolCallID})
		default:
			flushCommands()
			label := name
			if label == "" {
				label = "tool"
			}
			text := label + "已完成"
			if running {
				text = label + "运行中"
			}
			if cancelled {
				text = label + "已取消"
			}
			activities = append(activities, codexActivity{kind: "tool", text: text, label: codexActivityLabel(name), args: message.Data.Args, output: message.Data.Output, failure: message.Data.ErrorText, failed: message.Data.Error, cancelled: cancelled, key: message.Data.ToolCallID})
		}
	}
	flushCommands()
	return activities
}

func codexActivityIcon(kind string) *ui.SVG {
	switch kind {
	case "command":
		return iconTerminal
	case "image":
		return iconImage
	case "edit":
		return iconPencil
	}
	return iconSpark
}

func commandFromArgs(args string) string {
	trimmed := strings.TrimSpace(args)
	if trimmed == "" {
		return ""
	}
	var values map[string]any
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return ""
	}
	for _, key := range []string{"command", "cmd", "path", "query", "url", "pattern"} {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func argsText(values []string) string {
	kept := []string{}
	for _, value := range values {
		if value != "" {
			kept = append(kept, value)
		}
	}
	return strings.Join(kept, "\n")
}

func (c *chatState) toolRow(ctx *ui.Context, run transcriptRun) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	key := runKey(run)
	expanded := c.expanded[key]
	active := runActive(run)
	elapsed, timed := runElapsed(run, ctx.Now())
	worked := ""
	if timed {
		worked = codexWorkedFor(elapsed)
	}
	if active {
		ctx.After(time.Second)
	}
	label := "用时 " + worked
	if worked == "" {
		label = strconv.Itoa(len(run.messages)) + " 次工具调用"
	}
	header := ui.Row(ctx).FillWidth().Height(th.Space(7)).Gap(th.Space(1.5)).AlignItems(ui.Center).
		Label(label).Focusable()
	header.OnClick(func() {
		c.expanded[key] = !expanded
		c.frame()
	})
	header.Children(func() {
		ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
		kit.Text(ctx, label, t.Text.Xs).TextColor(t.Muted).SingleLine()
	})
	kit.Separator(ctx, false)
	if !expanded {
		return
	}
	for _, activity := range codexActivities(run) {
		rowKey := "act:" + activity.key
		if activity.key == "" {
			rowKey = "act:" + activity.text
		}
		open := c.expanded[rowKey]
		row := ui.Row(ctx).FillWidth().Height(th.Space(8)).Gap(th.Space(2)).AlignItems(ui.Center).
			Label(activity.text).Focusable()
		row.OnClick(func() {
			c.expanded[rowKey] = !open
			c.frame()
		})
		row.Children(func() {
			ui.Icon(ctx, codexActivityIcon(activity.kind)).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
			kit.Text(ctx, activity.text, t.Text.Sm).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
			chevron := ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
			if open {
				chevron.Rotate(180)
			}
		})
		if open {
			c.activityPanel(ctx, activity)
		}
	}
}

func (c *chatState) activityPanel(ctx *ui.Context, activity codexActivity) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	panel := ui.Column(ctx).FillWidth().Padding(th.Space(3)).Radius(t.Radius.Sm).
		Border(gwtheme.Hairline, t.Border).Background(t.Card).Gap(th.Space(1.5))
	panel.Children(func() {
		kit.Text(ctx, activity.label, t.Text.Xs).TextColor(t.Muted)
		if activity.command != "" {
			kit.Text(ctx, "$ "+activity.command, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Foreground)
		}
		if args := activityArguments(activity); args != "" {
			kit.Text(ctx, "参数", t.Text.Xs).TextColor(t.Muted).Padding(0, 0, th.Space(0.5), 0)
			kit.Text(ctx, args, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Foreground)
		}
		if output := activityOutput(activity.output); output != "" {
			kit.Text(ctx, "输出", t.Text.Xs).TextColor(t.Muted).Padding(0, 0, th.Space(0.5), 0)
			kit.Text(ctx, output, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Muted)
		}
		if activity.failure != "" {
			kit.Text(ctx, "错误", t.Text.Xs).TextColor(t.Muted).Padding(0, 0, th.Space(0.5), 0)
			kit.Text(ctx, activity.failure, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Danger)
		}
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Justify(ui.End).Children(func() {
			if activity.cancelled {
				ui.Icon(ctx, iconClose).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
				kit.Text(ctx, "已取消", t.Text.Xs).TextColor(t.Muted)
				return
			}
			if activity.failed {
				ui.Icon(ctx, iconClose).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Danger)
				kit.Text(ctx, "失败", t.Text.Xs).TextColor(t.Danger)
				return
			}
			ui.Icon(ctx, iconCheck).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
			kit.Text(ctx, "成功", t.Text.Xs).TextColor(t.Muted)
		})
	})
}

func activityArguments(activity codexActivity) string {
	args := strings.TrimSpace(activity.args)
	if args == "" || args == "{}" || args == "null" {
		return ""
	}
	if activity.command == "" {
		return args
	}
	kept := []string{}
	for _, line := range strings.Split(args, "\n") {
		compact := strings.TrimSpace(commandArgumentOnly(line, activity.command))
		if compact == "" || compact == "{}" || compact == "null" {
			continue
		}
		kept = append(kept, compact)
	}
	return strings.Join(kept, "\n")
}

func commandArgumentOnly(args, command string) string {
	var values map[string]any
	if err := json.Unmarshal([]byte(args), &values); err != nil {
		return args
	}
	delete(values, "command")
	delete(values, "cmd")
	delete(values, "timeout")
	if len(values) == 0 {
		return ""
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return args
	}
	return string(encoded)
}

func activityOutput(output string) string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return ""
	}
	lines := strings.Split(trimmed, "\n")
	if len(lines) > 24 {
		lines = append(lines[:24], "… 还有 "+strconv.Itoa(len(lines)-24)+" 行")
	}
	kept := strings.Join(lines, "\n")
	runes := []rune(kept)
	if len(runes) > 3_000 {
		kept = string(runes[:3_000]) + "…"
	}
	return kept
}

func chatRightFade() ui.LinearGradient {
	return ui.LinearGradient{Angle: 90, Stops: []ui.GradientStop{
		{Color: ui.RGB(0, 0, 0), At: 0},
		{Color: ui.RGB(0, 0, 0), At: 0.94},
		{Color: ui.Transparent, At: 1},
	}}
}

func (c *chatState) messageRow(ctx *ui.Context, message transcriptMessage) {
	if message.ID != "" && message.ID == c.jumpMessageID {
		t, th := gwtheme.Of(ctx), ctx.Theme()
		box := ui.Column(ctx).FillWidth().Padding(th.Space(1), th.Space(1)).
			Radius(t.Radius.Lg).Background(t.Highlight.Alpha(0.28)).Label("定位到这条消息")
		box.Children(func() { c.plainMessageRow(ctx, message) })
		return
	}
	c.plainMessageRow(ctx, message)
}

func (c *chatState) plainMessageRow(ctx *ui.Context, message transcriptMessage) {
	if message.Kind == "verification_draft" && message.Data.VerificationDraft != nil {
		c.verificationDraftRow(ctx, message.Text, *message.Data.VerificationDraft)
		return
	}
	if message.Data.Source.Form == "notice" || message.Data.Source.Kind == "tool_settled" {
		c.noticeRow(ctx, message)
		return
	}
	mine := message.Role == "user"
	if !mine {
		th := ctx.Theme()
		ui.Column(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
			c.answerClockRow(ctx, message)
			if markdownHasTable(message.Text) {
				fade := ui.Box(ctx).FillWidth().MaskLinearGradient(chatRightFade())
				fade.Children(func() { c.markdownMessage(ctx, message) })
			} else {
				c.markdownMessage(ctx, message)
			}
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

func (c *chatState) noticeRow(ctx *ui.Context, message transcriptMessage) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	summary := strings.TrimSpace(message.Data.Source.Summary)
	if summary == "" {
		summary = "后台任务已结束"
		if tool := strings.TrimSpace(message.Data.Source.Tool); tool != "" {
			summary = tool + " 已结束"
		}
	}
	card := ui.Column(ctx).FillWidth().MaxWidthPercent(84).Gap(th.Space(0.75)).
		Padding(th.Space(1.5), th.Space(2)).Radius(t.Radius.Lg).Background(t.Card).
		Border(gwtheme.Hairline, t.Border).Label("后台任务通知")
	card.Children(func() {
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			ui.Icon(ctx, iconSpark).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
			kit.Text(ctx, summary, t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
			if message.CreatedAt > 0 {
				kit.Text(ctx, messageClock(message.CreatedAt), t.Text.Xs).TextColor(t.Muted)
			}
		})
		kit.Text(ctx, message.Text, t.Text.Sm).TextColor(t.Muted)
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
		for index, attachment := range message.Data.Attachments {
			if !attachment.isImage() {
				continue
			}
			if !c.messagePicture(ctx, message.ID, index) {
				kit.Text(ctx, attachment.Name, t.Text.Xs).TextColor(t.Muted)
			}
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

func markdownHasTable(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) >= 3 && strings.HasPrefix(trimmed, "|") && strings.HasSuffix(trimmed, "|") {
			return true
		}
	}
	return false
}
