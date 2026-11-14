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
	kind    string
	text    string
	label   string
	command string
	args    string
	output  string
	failed  bool
	key     string
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
	failed := false
	key := ""
	flushCommands := func() {
		if len(commands) == 0 {
			return
		}
		activities = append(activities, codexActivity{
			kind: "command", text: "已运行 " + strings.Join(commands, "; "), label: "Shell",
			command: strings.Join(commands, "; "), args: argsText(argsValues), output: strings.Join(outputs, "\n\n"), failed: failed, key: key,
		})
		commands, argsValues, outputs, failed, key = nil, nil, nil, false, ""
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
		running := message.State != "done"
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
		case codexImageTools[name]:
			flushCommands()
			text := "已查看 1 张图像"
			if running {
				text = "正在查看图像"
			}
			activities = append(activities, codexActivity{kind: "image", text: text, label: "Image", args: message.Data.Args, output: message.Data.Output, key: message.Data.ToolCallID})
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
			activities = append(activities, codexActivity{kind: "edit", text: text, label: "Edit", command: payload, args: message.Data.Args, output: message.Data.Output, failed: message.Data.Error, key: message.Data.ToolCallID})
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
			activities = append(activities, codexActivity{kind: "tool", text: text, label: codexActivityLabel(name), args: message.Data.Args, output: message.Data.Output, failed: message.Data.Error, key: message.Data.ToolCallID})
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

func runElapsed(run transcriptRun) time.Duration {
	if len(run.messages) < 2 {
		return 0
	}
	start := run.messages[0].CreatedAt
	end := run.messages[len(run.messages)-1].CreatedAt
	if start <= 0 || end <= start {
		return 0
	}
	return time.Duration(end-start) * time.Millisecond
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

func codexWorkedFor(elapsed time.Duration) string {
	seconds := int64(elapsed / time.Second)
	if seconds <= 0 {
		seconds = 1
	}
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	rest := seconds % 60
	switch {
	case hours > 0:
		return strconv.FormatInt(hours, 10) + "h " + strconv.FormatInt(minutes, 10) + "m"
	case minutes > 0:
		return strconv.FormatInt(minutes, 10) + "m " + strconv.FormatInt(rest, 10) + "s"
	}
	return strconv.FormatInt(rest, 10) + "s"
}

func (c *chatState) toolRow(ctx *ui.Context, run transcriptRun) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	key := runKey(run)
	expanded := c.expanded[key]
	worked := ""
	if elapsed := runElapsed(run); elapsed > 0 {
		worked = codexWorkedFor(elapsed)
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
		ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Justify(ui.End).Children(func() {
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
	mine := message.Role == "user"
	if !mine {
		th := ctx.Theme()
		ui.Column(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
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

func markdownHasTable(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) >= 3 && strings.HasPrefix(trimmed, "|") && strings.HasSuffix(trimmed, "|") {
			return true
		}
	}
	return false
}
