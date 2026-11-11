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
	ui.Column(ctx).Grow(1).Shrink(1).Children(func() {
		ui.Column(ctx).Grow(1).Shrink(1).Padding(16).Gap(10).Children(func() {
			if c.status != "" && len(c.messages) == 0 {
				ui.Text(ctx, c.status).TextColor(t.TextMuted)
				return
			}
			for _, question := range c.questions {
				card := question
				ui.Column(ctx).Gap(4).Children(func() {
					ui.Text(ctx, "需要你决定 · "+card.Kind).FontSize(12).TextColor(t.TextMuted)
					markdown.View(ctx, card.Data.Prompt, &c.md)
					for _, option := range card.Data.Options {
						value := option
						if ui.Button(ctx, value).Clicked() {
							go c.answer(card, value)
						}
					}
				})
			}
			if len(c.artifacts) > 0 {
				label := "产物 · " + strconv.Itoa(len(c.artifacts)) + " 件"
				if ui.Button(ctx, label).Clicked() {
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
			ui.Row(ctx).Gap(4).Children(func() {
				label := "换模型"
				if c.currentModel != "" {
					label = "模型：" + shortModel(c.currentModel) + " · " + c.currentThinking
				}
				if ui.Button(ctx, label).Clicked() {
					c.modelMenu = !c.modelMenu
				}
				if !c.modelMenu {
					return
				}
				for _, choice := range c.modelChoices() {
					model := choice
					if ui.Button(ctx, shortModel(model.id)+" · "+model.thinking).Clicked() {
						go c.selectModel(model, model.thinking)
					}
				}
			})
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
			ui.Row(ctx).Gap(4).Children(func() {
				label := "绑定项目"
				if c.project != "" {
					label = "项目：" + c.project
				}
				if ui.Button(ctx, label).Clicked() {
					c.binding = !c.binding
				}
				if !c.binding {
					return
				}
				for _, project := range c.projectChoices() {
					target := project
					if ui.Button(ctx, "绑定 "+target).Clicked() {
						go c.bindProject(target)
					}
				}
			})
			c.graphSection(ctx)
			runs := groupRuns(c.messages)
			start := windowStart(len(runs), c.visible)
			if start > 0 && c.loadOlderAtTop() {
				start = windowStart(len(runs), c.visible)
			}
			if start > 0 {
				label := "加载更早的 " + strconv.Itoa(start) + " 段（往上翻）"
				if ui.Button(ctx, label).Clicked() {
					c.visible += transcriptWindow
				}
			}
			shown := runs[start:]
			c.list.Key = func(row int) any { return start + row }
			ui.List(ctx, &c.list, len(shown), func(index int) {
				run := shown[index]
				if run.tools {
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
					return
				}
				message := run.messages[0]
				ui.Column(ctx).Gap(4).Children(func() {
					author := "agent"
					if message.Role == "user" {
						author = "你"
					}
					ui.Text(ctx, author).FontSize(12).TextColor(t.TextMuted)
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
			}).Grow(1)
			if c.status != "" && len(c.messages) > 0 {
				ui.Text(ctx, c.status).FontSize(12).TextColor(t.TextMuted)
			}
		})
		ui.Row(ctx).Gap(8).Padding(0, 16, 16, 16).AlignItems(ui.End).Children(func() {
			ui.TextInput(ctx, &c.draft).Placeholder("给 Graph 发消息…").Label("消息").Grow(1)
			if ui.PrimaryButton(ctx, "发送").Clicked() {
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
	})
}
