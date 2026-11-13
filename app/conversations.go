package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type conversationSummary struct {
	ID            string `json:"id"`
	Role          string `json:"role"`
	ArchivedAt    *int64 `json:"archivedAt"`
	Title         string `json:"title"`
	ProjectID     string `json:"projectId"`
	Status        string `json:"status"`
	OpenQuestions int    `json:"openQuestions"`
	UpdatedAt     int64  `json:"updatedAt"`
}

type questionOptions struct {
	Prompt   string   `json:"prompt"`
	Options  []string `json:"options"`
	Multiple bool     `json:"multiple"`
}

type openQuestion struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Status    string          `json:"status"`
	Suspended bool            `json:"suspended"`
	TaskID    string          `json:"taskId"`
	Owner     string          `json:"owner"`
	Data      questionOptions `json:"data"`
}

func (q openQuestion) open() bool {
	return q.Status != "resolved" && (q.Suspended || q.Status == "open" || q.Status == "waiting")
}

type conversationBody struct {
	Messages  []transcriptMessage `json:"messages"`
	Questions []openQuestion      `json:"questions"`
	Paused    bool                `json:"paused"`
}

func (c conversationSummary) ArchivedAtPresent() bool { return c.ArchivedAt != nil }

func parseConversations(payload []byte) ([]conversationSummary, error) {
	list := []conversationSummary{}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return list, nil
	}
	if err := json.Unmarshal(payload, &list); err != nil {
		return nil, err
	}
	return list, nil
}

func parseConversationRaw(payload []byte) ([]transcriptMessage, error) {
	var body struct {
		Messages []transcriptMessage `json:"messages"`
	}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, err
	}
	return body.Messages, nil
}

func parseConversationMessages(payload []byte) ([]transcriptMessage, error) {
	var body conversationBody
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, err
	}
	var legacy struct {
		Messages []struct {
			Data map[string]any `json:"data"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(payload, &legacy)
	spoken := []transcriptMessage{}
	for index, message := range body.Messages {
		if strings.TrimSpace(message.Text) == "" {
			continue
		}
		if index < len(legacy.Messages) {
			if receipt, _ := legacy.Messages[index].Data["reloadReceipt"].(bool); receipt {
				continue
			}
		}
		if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
			continue
		}
		spoken = append(spoken, message)
	}
	return spoken, nil
}

func parseConversationBody(payload []byte) (conversationBody, error) {
	var body conversationBody
	if err := json.Unmarshal(payload, &body); err != nil {
		return body, err
	}
	return body, nil
}

func (c *chatState) answer(question openQuestion, value string) {
	body := map[string]any{
		"questionId": question.ID,
		"answer":     map[string]string{"type": "respond", "value": value},
		"requestId":  "native-" + question.ID + "-" + strconv.FormatInt(time.Now().UnixNano(), 36),
	}
	if _, err := c.api.post("/api/tasks/"+question.TaskID+"/answer", body); err != nil {
		c.status = "回答失败：" + err.Error()
		return
	}
	c.status = ""
	c.refresh()
	c.frame()
}

func (c *chatState) busy() bool {
	for _, message := range c.messages {
		if messageStreaming(message) {
			return true
		}
	}
	return false
}

func (c *chatState) send() {
	c.sendText(strings.TrimSpace(c.draft))
}

func (c *chatState) sendText(text string) {
	if text == "" || c.active == "" {
		return
	}
	if c.nodeMode {
		c.sendNode(text)
		return
	}
	body := map[string]string{"text": text, "requestId": "native-" + time.Now().Format("150405.000000")}
	if _, err := c.api.post("/api/conversations/"+c.active+"/messages", body); err != nil {
		c.status = "发送失败：" + err.Error()
		return
	}
	c.draft = ""
	c.status = "已发出，等待回复…"
	c.refresh()
	go c.follow()
}

func (c *chatState) follow() {
	for attempt := 0; attempt < 450; attempt++ {
		time.Sleep(400 * time.Millisecond)
		c.refresh()
		if len(c.messages) == 0 {
			continue
		}
		last := c.messages[len(c.messages)-1]
		if last.Role == "assistant" && !messageStreaming(last) {
			return
		}
	}
}

func (c *chatState) refresh() {
	if c.nodeMode {
		c.refreshNode()
		return
	}
	payload, err := c.api.get("/api/conversations/" + c.active)
	if err != nil {
		c.status = "读不到这个会话：" + err.Error()
		return
	}
	messages, err := parseConversationMessages(payload)
	if err != nil {
		c.status = "会话内容不是预期的 JSON：" + err.Error()
		return
	}
	if c.pagedHistory {
		c.messages = mergeMessages(c.messages, messages)
	} else {
		c.messages = messages
	}
	if len(messages) > 0 && messages[len(messages)-1].Role == "assistant" {
		c.status = ""
	}
}

func (c *chatState) open(id string) {
	payload, err := c.api.get("/api/conversations/" + id)
	if err != nil {
		c.status = "读不到这个会话：" + err.Error()
		return
	}
	messages, err := parseConversationMessages(payload)
	if err != nil {
		c.status = "会话内容不是预期的 JSON：" + err.Error()
		return
	}
	c.messages = messages
	c.fingerprint = transcriptFingerprint(messages)
	c.historyLoading = false
	c.pagedHistory = false
	c.runBoundaries = map[string]bool{}
	if len(messages) > 0 {
		c.runBoundaries[messages[0].ID] = true
	}
	raw, _ := parseConversationRaw(payload)
	c.oldestSeq = oldestSeqOf(raw)
	c.noMoreHistory = c.oldestSeq <= 0 || len(raw) < historyPageSize
	c.active = id
	c.questions = nil
	if body, err := parseConversationBody(payload); err == nil {
		c.paused = body.Paused
		for _, question := range body.Questions {
			if question.open() {
				c.questions = append(c.questions, question)
			}
		}
	}
	c.artifacts = nil
	c.preview = ""
	c.previewTitle = ""
	if listed, err := c.api.get("/api/conversations/" + id + "/artifacts"); err == nil {
		if rows, err := parseArtifacts(listed); err == nil {
			c.artifacts = rows
		}
	}
	c.tasks = nil
	if rows, err := parseGraphTasks(payload); err == nil {
		c.tasks = rows
	}
	if len(messages) == 0 {
		c.status = "这个会话还没有可显示的对话。"
		return
	}
	c.status = ""
}

func countLabel(count int) string {
	return strconv.Itoa(count) + " 次"
}

func (c *chatState) frame() {
	if c.window != nil {
		c.window.Update(func() {})
	}
}

func (c *chatState) view(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Column(ctx).Fill().Children(func() {
		c.agentHeader(ctx)
		c.transcript(ctx)
		if c.status != "" {
			ui.Text(ctx, c.status).FontSize(12).TextColor(th.TextMuted).Padding(16, 4, 16, 0)
		}
		bottom := ui.Column(ctx).FillWidth()
		bottom.Children(func() {
			if _, last := c.list.Visible(); last >= 0 && !c.list.AtEnd() {
				button := ui.Box(ctx).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Full).
					Background(t.Background).Border(gwtheme.Hairline, t.Input).Center().
					Label("回到最新").Tooltip("回到最新").Focusable()
				button.Attach(ui.AnchorTop, ui.AnchorBottom).Top(-th.Space(1.5))
				kit.Elevate(ctx, button, gwtheme.ShadowXs)
				button.OnClick(func() { c.list.ScrollToEnd() })
				button.Children(func() {
					ui.Icon(ctx, iconDown).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
				})
			}
			c.composer(ctx)
		})
	})
}

func (c *chatState) transcript(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if len(c.messages) == 0 {
		ui.Column(ctx).Grow(1).Center().Children(func() {
			kit.Text(ctx, "还没有对话", t.Text.Base).TextColor(t.Muted)
			kit.Text(ctx, "在下面输入第一条消息", t.Text.Sm).TextColor(t.Muted)
		})
		return
	}
	if c.historyLoading {
		kit.Text(ctx, "正在加载更早的对话…", t.Text.Xs).TextColor(t.Muted).Padding(0, 0, th.Space(1), 0)
	}
	runs := c.runs()
	c.list.Key = func(row int) any { return runIdentity(runs[row]) }
	fade := ui.Box(ctx).Grow(1).FillWidth()
	fade.Children(func() {
		list := ui.List(ctx, &c.list, len(runs), func(index int) {
			run := runs[index]
			if run.tools {
				c.toolRow(ctx, run)
				return
			}
			c.messageRow(ctx, run.messages[0])
		})
		list.Grow(1).Padding(0, th.Space(4), th.Space(4), th.Space(4)).Gap(th.Space(3))
		list.MaskLinearGradient(ui.LinearGradient{Angle: 180, Stops: []ui.GradientStop{
			{Color: ui.Transparent, At: 0},
			{Color: ui.RGB(0, 0, 0), At: 0.06},
			{Color: ui.RGB(0, 0, 0), At: 0.94},
			{Color: ui.Transparent, At: 1},
		}})
	})
	first, last := c.list.Visible()
	if c.historySettle > 0 {
		c.historySettle--
	} else if !c.historyLoading && first == 0 && last >= 0 && last < len(runs)-1 {
		c.ensureHistory()
	}
}

func messageClock(millis int64) string {
	return time.UnixMilli(millis).Format("15:04")
}

func copyMessage(text string) {
	_ = mygo.Clipboard.Write(transfer.TextData(text))
}

type composerMode int

const (
	composerSend composerMode = iota
	composerPause
	composerResume
)

func (c *chatState) composerMode() composerMode {
	if c.nodeMode {
		return composerSend
	}
	if c.busy() && !c.paused {
		return composerPause
	}
	if c.paused && strings.TrimSpace(c.draft) == "" {
		return composerResume
	}
	return composerSend
}

func (c *chatState) composer(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).Padding(th.Space(3), th.Space(4), th.Space(3), th.Space(4)).Children(func() {
		card := ui.Column(ctx).FillWidth().Padding(th.Space(3)).Gap(th.Space(2)).
			Radius(t.Radius.X2l).Background(t.Background).Border(gwtheme.Stroke, t.Input).Clip()
		kit.Elevate(ctx, card, composerShadow)
		card.Children(func() {
			field := kit.TextArea(ctx, &c.draft, kit.InputOpts{Placeholder: "想问什么？  @ 文件，$ 技能，/ 命令", Bare: true})
			field.Label("消息").FillWidth().PaddingX(th.Space(0.5)).Lines(1, 6)
			if c.focusComposer {
				field.Focus()
				c.focusComposer = false
			}
			field.OnTextKey(func(k ui.TextKey) bool {
				if k.Key != ui.KeyEnter || k.Mods != 0 {
					return false
				}
				text := strings.TrimSpace(k.Text())
				if text == "" {
					return true
				}
				go c.sendText(text)
				k.SetText("")
				return true
			})
			ui.Row(ctx).FillWidth().AlignItems(ui.Center).Gap(th.Space(1.5)).Children(func() {
				composerPlaceholder(ctx, iconClip, "附件")
				ui.Spacer(ctx)
				if !c.nodeMode {
					c.modelChip(ctx)
				}
				composerPlaceholder(ctx, iconMic, "语音")
				c.composerButton(ctx)
			})
		})
	})
}

func composerPlaceholder(ctx *ui.Context, icon *ui.SVG, label string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Box(ctx).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Md).Center().
		Label(label).Tooltip(label + "（即将支持）").Children(func() {
		ui.Icon(ctx, icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
	})
}

func (c *chatState) modelChip(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	text := strings.TrimSpace(shortModel(c.currentModel) + " " + c.currentThinking)
	if text == "" {
		text = "模型"
	}
	ui.Row(ctx).Gap(th.Space(1)).PaddingX(th.Space(1)).AlignItems(ui.Center).Label("模型").Tooltip("模型切换在白板").Children(func() {
		ui.Icon(ctx, iconSpark).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
		kit.Text(ctx, text, t.Text.Sm).FontWeight(500).TextColor(t.Muted)
	})
}

func (c *chatState) composerButton(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	mode := c.composerMode()
	icon, label := iconSend, "发送"
	switch mode {
	case composerPause:
		icon, label = iconPause, "暂停"
	case composerResume:
		icon, label = iconPlay, "继续"
	}
	color := t.PrimaryText
	button := ui.Box(ctx).Size(th.Space(9), th.Space(9)).Radius(t.Radius.Full).Center().
		Label(label).Tooltip(label).Focusable().Background(t.Primary)
	if mode == composerSend && strings.TrimSpace(c.draft) == "" {
		color = t.Muted
		button.Background(t.Hover)
	}
	button.OnClick(func() {
		switch mode {
		case composerPause:
			go c.setPaused(true)
		case composerResume:
			go c.setPaused(false)
		default:
			go c.send()
		}
	})
	button.Children(func() {
		ui.Icon(ctx, icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(color)
	})
}
