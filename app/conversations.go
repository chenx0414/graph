package main

import (
	"bytes"
	"encoding/json"
	"net/http"
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

type conversationBody struct {
	Messages  []transcriptMessage `json:"messages"`
	Questions []openQuestion      `json:"questions"`
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
	body, _ := json.Marshal(map[string]any{
		"questionId": question.ID,
		"answer":     map[string]string{"type": "respond", "value": value},
		"requestId":  "native-" + question.ID + "-" + strconv.FormatInt(time.Now().UnixNano(), 36),
	})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/tasks/"+question.TaskID+"/answer", bytes.NewReader(body))
	if err != nil {
		c.status = "回答失败：" + err.Error()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "回答失败：" + err.Error()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "回答被拒绝：" + response.Status
		return
	}
	c.status = ""
	c.refresh()
	c.frame()
}

func daemonGet(address, token, path string) ([]byte, error) {
	request, err := http.NewRequest("GET", strings.TrimSuffix(address, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	if token = strings.TrimSpace(token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload := make([]byte, 0, 64*1024)
	buffer := make([]byte, 64*1024)
	for {
		read, err := response.Body.Read(buffer)
		if read > 0 {
			payload = append(payload, buffer[:read]...)
		}
		if err != nil {
			break
		}
	}
	return payload, nil
}

func (c *chatState) interrupt() {
	if c.active == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"requestId": requestID("native-interrupt")})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/interrupt", bytes.NewReader(body))
	if err != nil {
		c.status = "打断失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "打断失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "打断被拒绝：" + response.Status
		c.frame()
		return
	}
	c.refresh()
	c.status = "已请求打断这一轮"
}

func (c *chatState) cancelQueued(messageID string) {
	body, _ := json.Marshal(map[string]string{"requestId": requestID("native-cancel")})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/messages/"+messageID+"/cancel", bytes.NewReader(body))
	if err != nil {
		c.status = "撤销失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "撤销失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "撤销被拒绝：" + response.Status
		c.frame()
		return
	}
	c.refresh()
	c.status = "已撤销排队消息"
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
	body, _ := json.Marshal(map[string]string{"text": text, "requestId": "native-" + time.Now().Format("150405.000000")})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/messages", bytes.NewReader(body))
	if err != nil {
		c.status = "发送失败：" + err.Error()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "发送失败：" + err.Error()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "发送被拒绝：" + response.Status
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
	payload, err := daemonGet(c.address, c.token, "/api/conversations/"+c.active)
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
	payload, err := daemonGet(c.address, c.token, "/api/conversations/"+id)
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
	c.active = id
	c.questions = nil
	if body, err := parseConversationBody(payload); err == nil {
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
	if listed, err := daemonGet(c.address, c.token, "/api/conversations/"+id+"/artifacts"); err == nil {
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
	ui.Column(ctx).Fill().Padding(16).Gap(10).Children(func() {
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
		ui.Row(ctx).Gap(8).AlignItems(ui.End).Children(func() {
			ui.TextInput(ctx, &c.draft).Placeholder("给 Graph 发消息…").Label("消息").Grow(1)
			if ui.PrimaryButton(ctx, "发送").Clicked() {
				go c.send()
			}
			if c.busy() && ui.Button(ctx, "打断这一轮").Clicked() {
				go c.interrupt()
			}
		})
	})
}
