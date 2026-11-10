package main

import (
	"encoding/json"
	"net/http"
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

type transcriptMessage struct {
	Role string `json:"role"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type conversationBody struct {
	Messages []transcriptMessage `json:"messages"`
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
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		spoken = append(spoken, message)
	}
	return spoken, nil
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

type chatState struct {
	address  string
	token    string
	status   string
	titles   []string
	ids      []string
	messages []transcriptMessage
	list     ui.ListState
	md       markdown.Options
}

func newChatState(address, token string) *chatState {
	state := &chatState{address: address, token: token, status: "正在读取会话…"}
	state.list.FollowEnd = true
	state.list.FollowAnimation = &ui.Smooth
	return state
}

func (c *chatState) load() {
	payload, err := daemonGet(c.address, c.token, "/api/conversations")
	if err != nil {
		c.status = "读不到会话列表：" + err.Error()
		return
	}
	list, err := parseConversations(payload)
	if err != nil {
		c.status = "会话列表不是预期的 JSON：" + err.Error()
		return
	}
	c.titles = make([]string, 0, len(list))
	c.ids = make([]string, 0, len(list))
	for _, conversation := range list {
		if conversation.ArchivedAtPresent() {
			continue
		}
		c.titles = append(c.titles, conversation.Title)
		c.ids = append(c.ids, conversation.ID)
	}
	c.status = ""
	if len(c.ids) == 0 {
		c.status = "还没有会话。"
		return
	}
	c.open(c.ids[0])
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
	if len(messages) == 0 {
		c.status = "这个会话还没有可显示的对话。"
		return
	}
	c.status = ""
}

func (c *chatState) view(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Column(ctx).Fill().Padding(16).Gap(10).Children(func() {
		ui.Text(ctx, "Graph · 原生会话（S2 预览）").FontSize(13).TextColor(t.TextMuted)
		if c.status != "" {
			ui.Text(ctx, c.status).TextColor(t.TextMuted)
			return
		}
		ui.List(ctx, &c.list, len(c.messages), func(index int) {
			message := c.messages[index]
			ui.Column(ctx).Gap(4).Children(func() {
				author := "agent"
				if message.Role == "user" {
					author = "你"
				}
				ui.Text(ctx, author).FontSize(12).TextColor(t.TextMuted)
				markdown.View(ctx, message.Text, &c.md)
			})
		}).Grow(1)
	})
}
