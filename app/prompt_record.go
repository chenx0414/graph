package main

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type promptSent struct {
	OperationID string  `json:"operationId"`
	At          int64   `json:"at"`
	Text        string  `json:"text"`
	Tools       *string `json:"tools"`
}

type promptRecord struct {
	TaskID   string      `json:"taskId"`
	NodeID   string      `json:"nodeId"`
	Kind     string      `json:"kind"`
	Recorded *promptSent `json:"recorded"`
	Notes    []string    `json:"notes"`
}

const contextTabContext, contextTabPrompt, contextTabTools = 0, 1, 2

func (s *shellState) promptTarget() (string, string) {
	scope := s.chatScope()
	if scope.Kind == "node" && scope.TaskID != "" {
		return scope.TaskID, scope.NodeID
	}
	if data := s.trajectory.data; data != nil && data.TaskId != "" {
		return data.TaskId, "master"
	}
	return "", ""
}

func (s *shellState) promptScopeKey() string {
	task, node := s.promptTarget()
	if task == "" {
		return ""
	}
	return task + "/" + node
}

func (s *shellState) ensurePromptRecord() {
	// This is reached from a render, so the decision and the flag it sets belong
	// to the shell's writer rather than to whichever goroutine is painting.
	var task, node string
	var api apiClient
	var start bool
	onUI(s.window, func() {
		task, node = s.promptTarget()
		if task == "" || node == "" {
			return
		}
		key := s.promptScopeKey()
		if key != s.promptScope {
			s.promptScope = key
			s.promptRecord = nil
			s.promptError = ""
			s.contextTab = contextTabContext
		}
		if s.promptLoading {
			return
		}
		if s.promptRecord != nil && time.Since(s.promptFetchedAt) < 3*time.Second {
			return
		}
		s.promptLoading = true
		api = s.api
		start = true
	})
	if !start {
		return
	}
	go func() {
		payload, err := api.get("/api/tasks/" + url.PathEscape(task) + "/nodes/" + url.PathEscape(node) + "/prompt")
		var record promptRecord
		if err == nil {
			err = json.Unmarshal(payload, &record)
		}
		onUI(s.window, func() {
			s.promptLoading = false
			s.promptFetchedAt = time.Now()
			if err != nil {
				s.promptError = err.Error()
				return
			}
			s.promptError = ""
			s.promptRecord = &record
		})
	}()
}

func promptCharacterCount(text string) string {
	return strconv.Itoa(len([]rune(text))) + " 字符"
}

func promptToolDeclarationText(tools string) string {
	if strings.TrimSpace(tools) == "" {
		return ""
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(tools), "", "  "); err != nil {
		return tools
	}
	return pretty.String()
}

func promptToolCount(tools string) int {
	var parsed []any
	if err := json.Unmarshal([]byte(tools), &parsed); err != nil {
		return 0
	}
	return len(parsed)
}

func (s *shellState) promptNotes() string {
	if s.promptError != "" {
		return "读不到这次的发送记录：" + s.promptError
	}
	if s.promptRecord == nil {
		return "正在读取最近一次模型请求…"
	}
	if s.promptRecord.Recorded == nil {
		if len(s.promptRecord.Notes) > 0 {
			return strings.Join(s.promptRecord.Notes, " ")
		}
		return "尚无实际模型发送记录。"
	}
	return ""
}

func (s *shellState) promptFootnote() string {
	if s.promptRecord == nil || s.promptRecord.Recorded == nil {
		return ""
	}
	return strings.Join(s.promptRecord.Notes, " ")
}

func (s *shellState) contextTabRow(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	row := ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Height(th.Space(7))
	row.Children(func() {
		for _, tab := range []struct {
			index int
			label string
		}{
			{contextTabContext, "上下文"},
			{contextTabPrompt, "System Prompt"},
			{contextTabTools, "工具声明"},
		} {
			index, label := tab.index, tab.label
			active := s.contextTab == index
			item := ui.Row(ctx).Height(th.Space(6)).PaddingX(th.Space(2)).Radius(t.Radius.Sm).
				AlignItems(ui.Center).Focusable().Label(label)
			if active || item.Hovered() {
				item.Background(t.HoverTint)
			}
			item.OnClick(func() {
				s.contextTab = index
				s.frame()
			})
			item.Children(func() {
				color := t.Muted
				if active {
					color = t.Foreground
				}
				kit.Text(ctx, label, t.Text.Xs).TextColor(color).SingleLine()
			})
		}
	})
}

func (s *shellState) contextPromptBody(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	s.ensurePromptRecord()
	notes := s.promptNotes()
	if notes != "" {
		kit.Text(ctx, notes, t.Text.Sm).TextColor(t.Muted)
		return
	}
	footnote := s.promptFootnote()
	recorded := s.promptRecord.Recorded
	if s.contextTab == contextTabPrompt {
		if recorded.Text == "" {
			kit.Text(ctx, "这次发送没有 system prompt。", t.Text.Sm).TextColor(t.Muted)
			return
		}
		ui.Column(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
			meta := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
			meta.Children(func() {
				kit.Text(ctx, "实际发出（最近一次模型请求）", t.Text.Xs).TextColor(t.Muted).SingleLine()
				kit.Text(ctx, promptCharacterCount(recorded.Text), t.Text.Xs).TextColor(t.Muted).SingleLine().Grow(1).Ellipsis("…")
				if kit.Button(ctx, "复制 Prompt", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
					copyMessage(recorded.Text)
				}
			})
			kit.Text(ctx, recorded.Text, t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Foreground)
			if footnote != "" {
				kit.Text(ctx, footnote, t.Text.Xs).TextColor(t.Muted)
			}
		})
		return
	}
	tools := ""
	if recorded.Tools != nil {
		tools = *recorded.Tools
	}
	if tools == "" {
		kit.Text(ctx, "这次发送没有工具声明。", t.Text.Sm).TextColor(t.Muted)
		return
	}
	ui.Column(ctx).FillWidth().Gap(th.Space(1)).Children(func() {
		meta := ui.Row(ctx).FillWidth().Gap(th.Space(2)).AlignItems(ui.Center)
		meta.Children(func() {
			kit.Text(ctx, "实际发送的工具声明", t.Text.Xs).TextColor(t.Muted).SingleLine()
			kit.Text(ctx, strconv.Itoa(promptToolCount(tools))+" 个工具 · "+promptCharacterCount(tools), t.Text.Xs).
				TextColor(t.Muted).SingleLine().Grow(1).Ellipsis("…")
			if kit.Button(ctx, "复制声明", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				copyMessage(tools)
			}
		})
		kit.Text(ctx, promptToolDeclarationText(tools), t.Text.Xs).Font(gwtheme.MonoFont).TextColor(t.Foreground)
		if footnote != "" {
			kit.Text(ctx, footnote, t.Text.Xs).TextColor(t.Muted)
		}
	})
}
