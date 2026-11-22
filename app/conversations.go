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
	ID                string `json:"id"`
	Role              string `json:"role"`
	ArchivedAt        *int64 `json:"archivedAt"`
	ProjectArchivedAt *int64 `json:"projectArchivedAt"`
	Title             string `json:"title"`
	ProjectID         string `json:"projectId"`
	Status            string `json:"status"`
	OpenQuestions     int    `json:"openQuestions"`
	UpdatedAt         int64  `json:"updatedAt"`
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

func (c conversationSummary) ProjectArchived() bool { return c.ProjectArchivedAt != nil }

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
		if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" && message.Kind != "verification_draft" {
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
		c.failUser("回答失败：" + err.Error())
		return
	}
	c.status = ""
	c.refresh()
	c.frame()
}

func (c *chatState) busy() bool {
	return c.roundPhase().busy()
}

func (c *chatState) send() {
	c.sendText(strings.TrimSpace(c.draft))
}

func (c *chatState) sendText(text string) {
	text = stripSpace(text)
	if text == "" || c.active == "" || c.source == nil {
		return
	}
	if err := c.source.Send(c, text); err != nil {
		c.failUser("发送失败：" + err.Error())
		return
	}
	if stripSpace(c.draft) == text {
		c.draft = ""
	}
	c.attachments = nil
	c.focusComposer = true
	c.status = ""
	c.problem = ""
	c.refresh()
	if c.source.Follows() {
		go c.follow()
	}
}

func (c *chatState) follow() {
	for attempt := 0; attempt < 450; attempt++ {
		time.Sleep(400 * time.Millisecond)
		c.refresh()
		if len(c.messages) == 0 {
			continue
		}
		if !c.roundPhase().busy() && roundAnswered(c.messages) {
			return
		}
	}
}

func (c *chatState) refresh() {
	if c.source == nil && c.active != "" {
		c.source = newConversationChatSource(c.api, c.active)
	}
	if c.source == nil {
		return
	}
	if _, err := c.source.Refresh(c); err != nil {
		c.failRead("连接中断，正在重连")
	}
}

func (c *chatState) open(id string) {
	c.openSource(newConversationChatSource(c.api, id))
}

func (c *chatState) openSource(source agentChatSource) {
	c.source = source
	c.active = source.Key()
	c.messages = nil
	c.fingerprint = ""
	c.status = ""
	c.loading = true
	c.questions = nil
	c.artifacts = nil
	c.tasks = nil
	err := source.Load(c)
	c.loading = false
	if err != nil && c.status == "" {
		c.failRead("连接中断，正在重连")
	}
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
	// A frame draws each picture once; counting per frame keeps the number meaningful.
	c.pictureCount = 0
	c.keepFresh(ctx)
	ui.Column(ctx).Fill().Children(func() {
		c.transcript(ctx)
		c.connectionStrip(ctx)
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

// connectionStrip reports a transport failure beside the chat instead of inside the composer.
// It sits above the input because the transcript is what is stale, and it disappears the moment
// a read succeeds.
func (c *chatState) connectionStrip(ctx *ui.Context) {
	if c.connection == "" {
		return
	}
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).FillWidth().AlignItems(ui.Center).Gap(th.Space(1.5)).
		Padding(th.Space(0.75), th.Space(2)).Radius(t.Radius.Md).
		Background(t.Card).Border(gwtheme.Hairline, t.Border).Children(func() {
		kit.Text(ctx, c.connection, t.Text.Xs).TextColor(t.Muted).FillWidth().SingleLine().Ellipsis("…")
	})
}

func (c *chatState) transcript(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	spoken, _ := splitCollabMessages(c.messages)
	if len(spoken) == 0 {
		if c.loading {
			skeletonChatTranscript(ctx)
			return
		}
		message, hint := "还没有对话", "在下面输入第一条消息"
		ui.Column(ctx).Grow(1).Center().Children(func() {
			kit.Text(ctx, message, t.Text.Base).TextColor(t.Muted)
			kit.Text(ctx, hint, t.Text.Sm).TextColor(t.Muted)
		})
		return
	}
	if c.historyLoading {
		kit.SkeletonLine(ctx, 30, th.Space(1.5)).Padding(0, 0, th.Space(1), 0)
	}
	rows := chatFoldRows(c.runs())
	c.list.Key = func(row int) any { return rows[row].key }
	fade := ui.Box(ctx).Grow(1).FillWidth()
	fade.Children(func() {
		list := ui.List(ctx, &c.list, len(rows), func(index int) {
			row := rows[index]
			switch row.kind {
			case "tools":
				c.toolRow(ctx, row.run)
			case "fold":
				c.foldRow(ctx, row)
			default:
				c.messageRow(ctx, row.run.messages[0])
			}
		})
		top, bottom := c.track.insets()
		list.Grow(1).Padding(top, th.Space(4), th.Space(4)+bottom, th.Space(4)).Gap(th.Space(3)).
			TrackScroll(&c.track.ScrollState)
		list.MaskLinearGradient(c.track.mask()).
			Draw(func(p *ui.Painter, r ui.Rect) { c.track.viewport = r.H })
	})
	first, last := c.list.Visible()
	c.listFirst, c.listLast = first, last
	if c.historySettle > 0 {
		c.historySettle--
	} else if !c.historyLoading && first == 0 && last >= 0 {
		c.ensureHistory()
	}
}

func messageClock(millis int64) string {
	// All chat timestamps share the one relative-date formatter: assistant and
	// user bubbles, notices and collaboration events call this helper. The
	// formatter owns the calendar rules and the empty state for missing data.
	return relativeTimeFromMillis(millis, time.Now())
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
	if c.source != nil && !c.source.Capabilities().Pause {
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
	ui.Column(ctx).Padding(th.Space(3), th.Space(4), th.Space(3), th.Space(4)).Children(func() {
		menuSlot := ui.Column(ctx).FillWidth()
		menuSlot.Children(func() {
			if c.menuTrigger == nil {
				ui.Box(ctx).Height(0)
				return
			}
			c.composerMenuView(ctx, c.composerMenuItems(c.menuTrigger))
			ui.Box(ctx).Height(th.Space(1.5))
		})
		card := ui.Column(ctx).FillWidth().Padding(th.Space(3)).Gap(th.Space(2)).
			Radius(t.Radius.X2l).Background(t.Background).Border(gwtheme.Stroke, t.Input).Clip()
		kit.Elevate(ctx, card, composerShadow)
		card.Children(func() {
			if len(c.attachments) > 0 {
				c.attachmentStrip(ctx)
			}
			if strings.Contains(c.draft, "$") {
				c.ensureComposerSkills()
			}
			field := kit.TextArea(ctx, &c.draft, kit.InputOpts{Placeholder: c.composerPlaceholder(), Bare: true})
			field.Label("消息").FillWidth().PaddingX(th.Space(0.5)).Lines(2, 6)
			field.OnPaste(c.handleComposerPaste)
			field.TextRanges(composerTextRanges(composerTokens(c.draft, c.composerSkillNames()))...)
			if c.focusComposer {
				field.Focus()
				c.focusComposer = false
			}
			field.OnTextKey(func(k ui.TextKey) bool {
				if c.composerMenuKey(k) {
					return true
				}
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
			if c.problem != "" {
				kit.Text(ctx, c.problem, t.Text.Xs).TextColor(t.Danger).FillWidth().SingleLine().Ellipsis("…")
			}
			ui.Row(ctx).FillWidth().AlignItems(ui.Center).Gap(th.Space(1.5)).Children(func() {
				if c.source != nil && c.source.Capabilities().Attachments {
					c.attachmentButton(ctx)
				} else {
					composerPlaceholder(ctx, iconClip, "附件")
				}
				ui.Spacer(ctx)
				if c.source == nil || c.source.Capabilities().ModelChip {
					c.modelChip(ctx)
				}
				composerPlaceholder(ctx, iconMic, "语音")
				c.composerButton(ctx)
			})
			c.composerTrackTrigger(field)
		})
	})
}

func (c *chatState) composerPlaceholder() string {
	return "想问什么？  @ 文件，$ 技能，/ 命令"
}

// failUser reports something the user did or must decide: a rejected send, a failed confirm.
// It belongs in the composer, next to the action that produced it.
func (c *chatState) failUser(text string) {
	c.status = text
	c.problem = text
}

// failRead reports that the console could not reach the daemon. That is a transport fact the
// poll retries on its own, so it lives in connection - a strip beside the chat - and never in
// the composer: writing it there printed a red URL under the input every time a reload dropped
// the socket, and the one-second poll put it straight back.
func (c *chatState) failRead(text string) {
	c.status = text
	c.connection = text
}

// clearReadFailure drops a transport complaint once a read succeeds, so a single reload cannot
// leave a permanent warning on a healthy conversation.
func (c *chatState) clearReadFailure() {
	if c.connection != "" {
		c.connection = ""
	}
}

func (c *chatState) composerTrackTrigger(field ui.Element) {
	if c.pendingCaret >= 0 {
		field.SetTextSelection(c.pendingCaret, c.pendingCaret)
		c.caret = c.pendingCaret
		c.pendingCaret = -1
	} else if _, end := field.TextSelection(); end >= 0 {
		c.caret = end
	}
	trigger := detectComposerTrigger(c.draft, c.caret)
	if trigger != nil && c.menuDismissed == c.draft {
		trigger = nil
	}
	if trigger == nil {
		c.menuTrigger = nil
		c.menuActive = 0
		c.menuDismissed = ""
		return
	}
	if c.menuTrigger == nil || c.menuTrigger.kind != trigger.kind || c.menuTrigger.query != trigger.query {
		c.menuActive = 0
	}
	c.menuTrigger = trigger
	c.ensureComposerPaths()
	c.ensureComposerSkills()
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
	text := "模型"
	if c.currentModel != "" {
		text = strings.TrimSpace(shortModel(c.currentModel) + " " + c.currentThinking)
		if text == "" {
			text = "模型"
		}
	}
	chip := ui.Row(ctx).Gap(th.Space(1)).PaddingX(th.Space(1)).AlignItems(ui.Center).Label("模型").
		Focusable().Radius(t.Radius.Sm)
	if c.modelPicker.open {
		chip.Background(t.Hover)
	}
	chip.OnClick(func() {
		c.modelPicker.open = !c.modelPicker.open
		c.modelPicker.pending = nil
		c.modelPicker.focus = c.modelPicker.open
		c.frame()
	})
	chip.Children(func() {
		ui.Icon(ctx, iconSpark).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
		kit.Text(ctx, text, t.Text.Sm).FontWeight(500).TextColor(t.Muted).SingleLine()
		ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
	})
	c.modelPickerOverlay(ctx, chip)
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
