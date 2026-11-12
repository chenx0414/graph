package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
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
	Questions []openQuestion `json:"questions"`
	Paused    bool           `json:"paused"`
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

func parseConversationMessages(payload []byte) ([]transcriptMessage, error) {
	var body conversationBody
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, err
	}
	spoken := []transcriptMessage{}
	for _, message := range body.Messages {
		if strings.TrimSpace(message.Text) == "" {
			continue
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
	text := strings.TrimSpace(c.draft)
	if text == "" || c.active == "" {
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
	c.messages = messages
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
	c.visible = transcriptWindow
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
	t := ctx.Theme()
	ui.Column(ctx).Fill().Children(func() {
		c.transcript(ctx)
		if c.status != "" {
			ui.Text(ctx, c.status).FontSize(12).TextColor(t.TextMuted).Padding(16, 4, 16, 0)
		}
		c.composer(ctx)
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
	runs := groupRuns(c.messages)
	start := windowStart(len(runs), c.visible)
	if start > 0 && c.loadOlderAtTop() {
		start = windowStart(len(runs), c.visible)
	}
	if start > 0 {
		label := "加载更早的 " + strconv.Itoa(start) + " 段（往上翻）"
		kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm})
	}
	shown := runs[start:]
	c.list.Key = func(row int) any { return start + row }
	ui.List(ctx, &c.list, len(shown), func(index int) {
		run := shown[index]
		if run.tools {
			c.toolRow(ctx, run)
			return
		}
		c.messageRow(ctx, run.messages[0])
	}).Grow(1).Padding(th.Space(4)).Gap(th.Space(3))
}

func (c *chatState) toolRow(ctx *ui.Context, run transcriptRun) {
	t := gwtheme.Of(ctx)
	key := runKey(run)
	ui.Column(ctx).Gap(2).Children(func() {
		label := "工具 · " + runSummary(run) + " · " + countLabel(len(run.messages))
		if kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
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
	ui.Row(ctx).FillWidth().Children(func() {
		if mine {
			ui.Spacer(ctx)
		}
		ui.Column(ctx).MaxWidthPercent(84).Gap(ctx.Theme().Space(1)).Children(func() {
			c.bubble(ctx, message, mine)
			c.messageMeta(ctx, message, mine)
		})
		if !mine {
			ui.Spacer(ctx)
		}
	})
}

func (c *chatState) bubble(ctx *ui.Context, message transcriptMessage, mine bool) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	bubble := ui.Column(ctx).Padding(th.Space(2.5), th.Space(3.5)).Radius(t.Radius.Xl).Gap(th.Space(1)).Clip().
		Border(gwtheme.Hairline, t.Border)
	if mine {
		bubble.Background(t.Hover)
	} else {
		bubble.Background(t.Background)
		kit.Elevate(ctx, bubble, gwtheme.ShadowXs)
	}
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
	})
}

func messageClock(millis int64) string {
	return time.UnixMilli(millis).Format("15:04")
}

func copyMessage(text string) {
	_ = mygo.Clipboard.Write(transfer.TextData(text))
}

func (c *chatState) composer(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).Gap(th.Space(2)).Padding(th.Space(3), th.Space(4), th.Space(3.5), th.Space(4)).
		AlignItems(ui.Center).Children(func() {
		group := kit.InputGroup(ctx, kit.InputOpts{})
		group.Height(th.Space(11)).Radius(t.Radius.Xl).Padding(0).Grow(1)
		group.Children(func() {
			field := kit.Input(ctx, &c.draft, kit.InputOpts{Placeholder: "输入消息…", Bare: true})
			field.Label("消息").Grow(1).PaddingX(th.Space(3))
			if c.focusComposer {
				field.Focus()
				c.focusComposer = false
			}
			send := ui.Box(ctx).Size(th.Space(9), th.Space(9)).Radius(t.Radius.Full).Background(t.Primary).Center().
				Label("发送").Tooltip("发送").Focusable()
			send.Margin(0, th.Space(1), th.Space(1), 0)
			send.OnClick(func() { go c.send() })
			send.Children(func() {
				ui.Icon(ctx, iconSend).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.PrimaryText)
			})
		})
		if c.busy() && kit.Button(ctx, "打断这一轮", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			go c.interrupt()
		}
		if c.paused {
			if kit.Button(ctx, "继续", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				go c.setPaused(false)
			}
			return
		}
		if kit.Button(ctx, "暂停", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
			go c.setPaused(true)
		}
	})
}
