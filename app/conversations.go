package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
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

type transcriptMessage struct {
	Role  string `json:"role"`
	Kind  string `json:"kind"`
	Text  string `json:"text"`
	State string `json:"state"`
	Data  struct {
		Tool       string `json:"tool"`
		ToolCallID string `json:"toolCallId"`
		Ordinal    int    `json:"ordinal"`
	} `json:"data"`
}

type transcriptRun struct {
	tools    bool
	messages []transcriptMessage
}

func groupRuns(messages []transcriptMessage) []transcriptRun {
	runs := []transcriptRun{}
	for _, message := range messages {
		isTool := message.Role == "tool"
		if isTool && len(runs) > 0 && runs[len(runs)-1].tools {
			runs[len(runs)-1].messages = append(runs[len(runs)-1].messages, message)
			continue
		}
		runs = append(runs, transcriptRun{tools: isTool, messages: []transcriptMessage{message}})
	}
	return runs
}

func runSummary(run transcriptRun) string {
	names := []string{}
	seen := map[string]bool{}
	running := false
	for _, message := range run.messages {
		name := message.Data.Tool
		if name == "" {
			name = "tool"
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
		if message.State != "done" {
			running = true
		}
	}
	head := strings.Join(names, ", ")
	if running {
		return head + " · 进行中"
	}
	return head
}

func messageStreaming(message transcriptMessage) bool {
	return message.Role == "assistant" && message.State == "streaming"
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

func runKey(run transcriptRun) string {
	if len(run.messages) == 0 {
		return ""
	}
	return run.messages[0].Data.ToolCallID
}

func toolLine(message transcriptMessage) string {
	name := message.Data.Tool
	if name == "" {
		name = "tool"
	}
	state := "完成"
	if message.State != "done" {
		state = "进行中"
	}
	text := strings.TrimSpace(message.Text)
	if index := strings.Index(text, ": "); index >= 0 && index < 40 {
		text = text[index+2:]
	}
	if newline := strings.Index(text, "\n"); newline >= 0 {
		text = text[:newline]
	}
	runes := []rune(text)
	if len(runes) > 80 {
		text = string(runes[:80]) + "…"
	}
	if text == "" {
		return name + " · " + state
	}
	return name + " · " + state + " · " + text
}

const transcriptWindow = 40

func windowStart(total, visible int) int {
	if visible <= 0 {
		visible = transcriptWindow
	}
	if total <= visible {
		return 0
	}
	return total - visible
}

type chatState struct {
	questions []openQuestion
	visible   int
	expanded  map[string]bool
	window    *mygo.Window
	address   string
	token     string
	draft     string
	active    string
	status    string
	messages  []transcriptMessage
	list      ui.ListState
	md        markdown.Options
}

func newChatState(address, token string) *chatState {
	state := &chatState{address: address, token: token, status: "正在读取会话…", expanded: map[string]bool{}, visible: transcriptWindow}
	state.list.FollowEnd = true
	state.list.FollowAnimation = &ui.Smooth
	return state
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
		runs := groupRuns(c.messages)
		start := windowStart(len(runs), c.visible)
		if start > 0 {
			label := "加载更早的 " + strconv.Itoa(start) + " 段（往上翻）"
			if ui.Button(ctx, label).Clicked() {
				c.visible += transcriptWindow
			}
		}
		shown := runs[start:]
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
		})
	})
}
