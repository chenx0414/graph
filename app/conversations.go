package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
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

type draftProposal struct {
	Version       int `json:"version"`
	DraftRevision int `json:"draftRevision"`
}

type conversationBody struct {
	Messages  []transcriptMessage `json:"messages"`
	Questions []openQuestion      `json:"questions"`
	Proposal  *draftProposal      `json:"proposal"`
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
	c.proposal = draftProposal{}
	c.branch = "main"
	if body, err := parseConversationBody(payload); err == nil {
		c.paused = body.Paused
		if body.Proposal != nil && body.Proposal.Version > 0 {
			c.proposal = *body.Proposal
		}
		for _, question := range body.Questions {
			if question.open() {
				c.questions = append(c.questions, question)
			}
		}
	}
	c.artifacts = nil
	c.artifactsOpen = false
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
	c.graphOpen = false
	c.nodeLines = nil
	c.nodeTitle = ""
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
			ui.Text(ctx, c.status).FontSize(12).TextColor(t.TextMuted).Padding(16, 6, 0, 6)
		}
		c.controls(ctx)
		c.composer(ctx)
	})
}

func (c *chatState) transcript(ctx *ui.Context) {
	t := ctx.Theme()
	if len(c.messages) == 0 {
		ui.Column(ctx).Grow(1).Center().Children(func() {
			ui.Text(ctx, "还没有对话").FontSize(14).TextColor(t.TextMuted)
			ui.Text(ctx, "在下面输入第一条消息").FontSize(12).TextColor(t.TextMuted)
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
		ui.Button(ctx, label).FontSize(12)
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
	}).Grow(1).Padding(16).Gap(12)
}

func (c *chatState) toolRow(ctx *ui.Context, run transcriptRun) {
	t := ctx.Theme()
	key := runKey(run)
	ui.Column(ctx).Gap(2).Children(func() {
		label := "工具 · " + runSummary(run) + " · " + countLabel(len(run.messages))
		if ui.Button(ctx, label).Clicked() {
			c.expanded[key] = !c.expanded[key]
		}
		if !c.expanded[key] {
			return
		}
		for _, message := range run.messages {
			ui.Text(ctx, toolLine(message)).FontSize(12).TextColor(t.TextMuted)
		}
	})
}

func (c *chatState) messageRow(ctx *ui.Context, message transcriptMessage) {
	mine := message.Role == "user"
	ui.Row(ctx).FillWidth().Gap(8).AlignItems(ui.Start).Children(func() {
		if !mine {
			c.avatar(ctx, false)
		}
		if mine {
			ui.Spacer(ctx)
		}
		c.bubble(ctx, message, mine)
		if !mine {
			ui.Spacer(ctx)
		}
		if mine {
			c.avatar(ctx, true)
		}
	})
}

func (c *chatState) avatar(ctx *ui.Context, mine bool) {
	fill := ui.Hex("#EDE2FF")
	if mine {
		fill = ui.Hex("#D8EAFF")
	}
	ui.Box(ctx).Size(26, 26).Radius(13).Background(fill).Margin(4, 0, 0, 0)
}

func (c *chatState) bubble(ctx *ui.Context, message transcriptMessage, mine bool) {
	bubble := ui.Column(ctx).MaxWidthPercent(86).Padding(10, 14).Radius(16).Gap(4).Clip()
	if mine {
		bubble.Gradient(ui.Hex("#CFE4FF"), ui.Hex("#E9F2FF"), 135)
	} else {
		bubble.Gradient(ui.Hex("#EBE1FF"), ui.Hex("#F8F2FF"), 135)
	}
	bubble.Children(func() {
		if messageQueued(message) {
			if ui.Button(ctx, "撤销这条排队消息").Clicked() {
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

func (c *chatState) controls(ctx *ui.Context) {
	t := ctx.Theme()
	if len(c.questions) > 0 || c.proposal.Version > 0 || len(c.artifacts) > 0 || c.preview != "" || len(c.tasks) > 0 || len(c.nodeLines) > 0 {
		ui.Scroll(ctx).MaxHeight(240).Children(func() {
			ui.Column(ctx).Padding(16, 6).Gap(8).Children(func() {
				for _, question := range c.questions {
					card := question
					ui.Column(ctx).Gap(4).Children(func() {
						ui.Text(ctx, "需要你决定 · "+card.Kind).FontSize(12).TextColor(t.TextMuted)
						markdown.View(ctx, card.Data.Prompt, &c.md)
						ui.Row(ctx).Gap(6).Wrap().Children(func() {
							for _, option := range card.Data.Options {
								value := option
								if ui.Button(ctx, value).Clicked() {
									go c.answer(card, value)
								}
							}
						})
					})
				}
				if len(c.artifacts) > 0 {
					label := "产物 · " + strconv.Itoa(len(c.artifacts)) + " 件"
					if ui.Button(ctx, label).AlignSelf(ui.Start).Clicked() {
						c.artifactsOpen = !c.artifactsOpen
					}
					if c.artifactsOpen {
						shown := c.artifacts
						hidden := 0
						if len(shown) > artifactListLimit {
							hidden = len(shown) - artifactListLimit
							shown = shown[:artifactListLimit]
						}
						for _, artifact := range shown {
							row := artifact
							if ui.Button(ctx, artifactLabel(row)).Clicked() {
								go c.showArtifact(row)
							}
						}
						if hidden > 0 {
							ui.Text(ctx, "还有 "+strconv.Itoa(hidden)+" 件未列出").FontSize(12).TextColor(t.TextMuted)
						}
					}
				}
				if c.preview != "" {
					ui.Row(ctx).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Text(ctx, "产物预览 · "+c.previewTitle).FontSize(12).TextColor(t.TextMuted).Grow(1)
						row := c.previewRow
						if ui.Button(ctx, "导出 "+artifactFileName(row)).Clicked() {
							go c.exportArtifactNow(row)
						}
					})
					ui.Text(ctx, c.preview).FontSize(12)
				}
				if c.proposal.Version > 0 {
					ui.Column(ctx).Gap(4).Children(func() {
						ui.Text(ctx, "草案 v"+strconv.Itoa(c.proposal.Version)+" · 修订 "+strconv.Itoa(c.proposal.DraftRevision)+" 待确认").FontSize(12).TextColor(t.TextMuted)
						ui.Row(ctx).Gap(8).AlignItems(ui.End).Children(func() {
							ui.TextInput(ctx, &c.branch).Placeholder("目标分支").Label("目标分支").Width(160)
							if ui.PrimaryButton(ctx, "确认草图并开始执行").Clicked() {
								go c.confirmDraft()
							}
						})
					})
				}
				c.graphSection(ctx)
			})
		})
	}
	ui.Row(ctx).Gap(4).Wrap().Padding(16, 2, 10, 2).Children(func() {
		label := "换模型"
		if c.currentModel != "" {
			label = "模型：" + shortModel(c.currentModel) + " · " + c.currentThinking
		}
		if ui.Button(ctx, label).Clicked() {
			c.modelMenu = !c.modelMenu
		}
		if c.modelMenu {
			for _, choice := range c.modelChoices() {
				model := choice
				if ui.Button(ctx, shortModel(model.id)+" · "+model.thinking).Clicked() {
					go c.selectModel(model, model.thinking)
				}
			}
		}
		bindLabel := "绑定项目"
		if c.project != "" {
			bindLabel = "项目：" + c.project
		}
		if ui.Button(ctx, bindLabel).Clicked() {
			c.binding = !c.binding
		}
		if c.binding {
			for _, project := range c.projectChoices() {
				target := project
				if ui.Button(ctx, "绑定 "+target).Clicked() {
					go c.bindProject(target)
				}
			}
		}
	})
}

func (c *chatState) composer(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Row(ctx).Gap(8).Padding(12, 16, 14, 16).AlignItems(ui.End).Children(func() {
		input := ui.TextInput(ctx, &c.draft).Placeholder("输入消息…").Label("消息").Grow(1)
		input.Background(t.Background).Border(1, t.Border).Radius(14).Padding(10, 14).FontSize(13)
		button := ui.PrimaryButton(ctx, "发送").Radius(14).Padding(10, 18)
		if button.Clicked() {
			go c.send()
		}
		if c.busy() && ui.Button(ctx, "打断这一轮").Clicked() {
			go c.interrupt()
		}
		if c.paused {
			if ui.Button(ctx, "继续").Clicked() {
				go c.setPaused(false)
			}
			return
		}
		if ui.Button(ctx, "暂停").Clicked() {
			go c.setPaused(true)
		}
	})
}
