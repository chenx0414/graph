package main

import (
	"net/url"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type chatCapabilities struct {
	HideConversations bool
	ModelChip         bool
	Pause             bool
	History           bool
}

type agentChatSource interface {
	Key() string
	Capabilities() chatCapabilities
	Load(c *chatState) error
	Refresh(c *chatState) (bool, error)
	Send(c *chatState, text string) error
	Follows() bool
}

type conversationChatSource struct {
	api apiClient
	id  string
}

func newConversationChatSource(api apiClient, id string) *conversationChatSource {
	return &conversationChatSource{api: api, id: id}
}

func (source *conversationChatSource) Key() string { return source.id }
func (source *conversationChatSource) Capabilities() chatCapabilities {
	return chatCapabilities{ModelChip: true, Pause: true, History: true}
}
func (source *conversationChatSource) Follows() bool { return true }

func (source *conversationChatSource) Load(c *chatState) error {
	payload, err := source.api.get("/api/conversations/" + source.id)
	if err != nil {
		c.status = "读不到这个会话：" + err.Error()
		return err
	}
	messages, err := parseConversationMessages(payload)
	if err != nil {
		c.status = "会话内容不是预期的 JSON：" + err.Error()
		return err
	}
	c.messages = messages
	c.fingerprint = transcriptFingerprint(messages)
	c.historyLoading = false
	c.pagedHistory = false
	c.historySettle = 0
	c.runBoundaries = map[string]bool{}
	if len(messages) > 0 {
		c.runBoundaries[messages[0].ID] = true
	}
	raw, _ := parseConversationRaw(payload)
	c.oldestSeq = oldestSeqOf(raw)
	c.noMoreHistory = c.oldestSeq <= 0 || len(raw) < historyPageSize
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
	if listed, err := source.api.get("/api/conversations/" + source.id + "/artifacts"); err == nil {
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
		return nil
	}
	c.status = ""
	return nil
}

func (source *conversationChatSource) Refresh(c *chatState) (bool, error) {
	payload, err := source.api.get("/api/conversations/" + source.id)
	if err != nil {
		return false, err
	}
	messages, err := parseConversationMessages(payload)
	if err != nil {
		return false, err
	}
	fingerprint := transcriptFingerprint(messages)
	body, bodyErr := parseConversationBody(payload)
	changed := fingerprint != c.fingerprint
	if bodyErr == nil {
		if body.Paused != c.paused || len(body.Questions) != len(c.questions) {
			changed = true
		}
	}
	if changed {
		c.fingerprint = fingerprint
		if c.pagedHistory {
			c.messages = mergeMessages(c.messages, messages)
		} else {
			c.messages = messages
		}
		if bodyErr == nil {
			c.paused = body.Paused
			c.questions = nil
			for _, question := range body.Questions {
				if question.open() {
					c.questions = append(c.questions, question)
				}
			}
		}
		if rows, err := parseGraphTasks(payload); err == nil {
			c.tasks = rows
		}
		if len(messages) > 0 {
			last := messages[len(messages)-1]
			if last.Role == "assistant" && !messageStreaming(last) {
				c.status = ""
			}
		}
	}
	return changed, nil
}

func (source *conversationChatSource) Send(c *chatState, text string) error {
	body := map[string]string{"text": text, "requestId": "native-" + time.Now().Format("150405.000000")}
	_, err := source.api.post("/api/conversations/"+source.id+"/messages", body)
	return err
}

type nodeChatSource struct {
	api    apiClient
	taskID string
	nodeID string
}

func newNodeChatSource(api apiClient, taskID, nodeID string) *nodeChatSource {
	return &nodeChatSource{api: api, taskID: taskID, nodeID: nodeID}
}

func (source *nodeChatSource) Key() string { return "node:" + source.taskID + "/" + source.nodeID }
func (source *nodeChatSource) Capabilities() chatCapabilities {
	return chatCapabilities{HideConversations: true}
}
func (source *nodeChatSource) Follows() bool { return false }

func (source *nodeChatSource) path(suffix string) string {
	return "/api/tasks/" + url.PathEscape(source.taskID) + "/nodes/" + url.PathEscape(source.nodeID) + suffix
}

func (source *nodeChatSource) Load(c *chatState) error {
	payload, err := source.api.get(source.path("/run") + "?limit=50")
	if err != nil {
		c.status = "读不到这个节点的记录：" + err.Error()
		return err
	}
	messages, err := parseNodeRunEntries(payload)
	if err != nil {
		c.status = "节点记录不是预期的 JSON"
		return err
	}
	c.messages = messages
	c.fingerprint = transcriptFingerprint(messages)
	c.noMoreHistory = true
	c.questions = nil
	c.artifacts = nil
	c.tasks = nil
	if len(messages) == 0 {
		c.status = "这个节点还没有可显示的记录。"
		return nil
	}
	c.status = ""
	return nil
}

func (source *nodeChatSource) Refresh(c *chatState) (bool, error) {
	payload, err := source.api.get(source.path("/run") + "?limit=50")
	if err != nil {
		return false, err
	}
	messages, err := parseNodeRunEntries(payload)
	if err != nil {
		return false, err
	}
	fingerprint := transcriptFingerprint(messages)
	if fingerprint == c.fingerprint {
		return false, nil
	}
	c.fingerprint = fingerprint
	c.messages = messages
	return true, nil
}

func (source *nodeChatSource) Send(c *chatState, text string) error {
	body := map[string]string{"text": text, "requestId": requestID("node-chat")}
	_, err := source.api.post(source.path("/messages"), body)
	return err
}

func (s *shellState) activeChatCapabilities() chatCapabilities {
	chat := s.active()
	if chat == nil || chat.source == nil {
		return chatCapabilities{ModelChip: true, Pause: true, History: true}
	}
	return chat.source.Capabilities()
}

func (s *shellState) installAgentChat(source agentChatSource, agent fleetAgent) {
	state := newChatState(s.api.address, s.api.token)
	state.window = s.window
	if agent.ID != "" {
		state.agentTitle = fleetAgentLabel(agent)
		state.agentStatus = agent.Status
		selected := agent
		state.agentDetail = func() { _ = s.openFleetAgentPage(selected) }
	}
	state.openSource(source)
	s.chatMu.Lock()
	s.activeID = state.active
	s.chat = state
	s.chatMu.Unlock()
	s.frame()
}

func stripSpace(text string) string { return strings.TrimSpace(text) }

func (c *chatState) agentHeader(ctx *ui.Context) {
	if c.agentTitle == "" {
		return
	}
	t, th := gwtheme.Of(ctx), ctx.Theme()
	row := ui.Row(ctx).FillWidth().Padding(th.Space(1.5), th.Space(3)).Gap(th.Space(1.5)).AlignItems(ui.Center).
		Background(t.Card).Border(gwtheme.Hairline, t.Border)
	row.Children(func() {
		fleetAvatar(ctx, fleetGraphInitial(c.agentTitle), t.Primary, th.Space(5))
		ui.Column(ctx).Gap(0).Grow(1).Children(func() {
			kit.Text(ctx, c.agentTitle, t.Text.Sm).FontWeight(650).TextColor(t.Foreground).SingleLine().Ellipsis("…")
			if c.agentStatus != "" {
				ui.Row(ctx).Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
					fleetStatusDot(ctx, c.agentStatus)
					kit.Text(ctx, fleetStatusLabel(c.agentStatus), t.Text.Xs).TextColor(t.Muted)
				})
			}
		})
		if c.agentDetail != nil {
			detail := c.agentDetail
			kit.Button(ctx, "详情", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).OnClick(func() { go detail() })
		}
	})
}
