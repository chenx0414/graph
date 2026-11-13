package main

import (
	"encoding/json"
	"net/url"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (c *chatState) openNode(agent fleetAgent) {
	c.nodeMode = true
	c.nodeTaskID = agent.TaskID
	c.nodeID = agent.NodeID
	c.active = "node:" + agent.TaskID + "/" + agent.NodeID
	c.agentTitle = fleetAgentLabel(agent)
	c.agentStatus = agent.Status
	c.messages = nil
	c.fingerprint = ""
	c.noMoreHistory = true
	c.status = "正在读取节点记录…"
	payload, err := c.api.get(c.nodePath("/run") + "?limit=50")
	if err != nil {
		c.status = "读不到这个节点的记录：" + err.Error()
		return
	}
	messages, err := parseNodeRunEntries(payload)
	if err != nil {
		c.status = "节点记录不是预期的 JSON"
		return
	}
	c.messages = messages
	c.fingerprint = transcriptFingerprint(messages)
	if len(messages) == 0 {
		c.status = "这个节点还没有可显示的记录。"
		return
	}
	c.status = ""
}

func (c *chatState) nodePath(suffix string) string {
	return "/api/tasks/" + url.PathEscape(c.nodeTaskID) + "/nodes/" + url.PathEscape(c.nodeID) + suffix
}

func (c *chatState) refreshNode() {
	payload, err := c.api.get(c.nodePath("/run") + "?limit=50")
	if err != nil {
		c.status = "读不到这个节点的记录：" + err.Error()
		return
	}
	messages, err := parseNodeRunEntries(payload)
	if err != nil {
		c.status = "节点记录不是预期的 JSON"
		return
	}
	c.messages = messages
	c.fingerprint = transcriptFingerprint(messages)
}

func (c *chatState) pollNode() bool {
	payload, err := c.api.get(c.nodePath("/run") + "?limit=50")
	if err != nil {
		return false
	}
	messages, err := parseNodeRunEntries(payload)
	if err != nil {
		return false
	}
	fingerprint := transcriptFingerprint(messages)
	if fingerprint == c.fingerprint {
		return false
	}
	c.fingerprint = fingerprint
	c.messages = messages
	if len(messages) > 0 && c.status == "正在读取节点记录…" {
		c.status = ""
	}
	return true
}

func (c *chatState) sendNode(text string) {
	body := map[string]string{"text": text, "requestId": requestID("node-chat")}
	if _, err := c.api.post(c.nodePath("/messages"), body); err != nil {
		c.status = "发送失败：" + err.Error()
		return
	}
	c.draft = ""
	c.status = "已发出，等待节点回复…"
	c.refreshNode()
}

func parseNodeRunEntries(payload []byte) ([]transcriptMessage, error) {
	var raw struct {
		Entries []struct {
			Seq       int64  `json:"seq"`
			ID        string `json:"id"`
			Role      string `json:"role"`
			Kind      string `json:"kind"`
			Text      string `json:"text"`
			State     string `json:"state"`
			CreatedAt int64  `json:"createdAt"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, err
	}
	messages := []transcriptMessage{}
	for _, entry := range raw.Entries {
		text := strings.TrimSpace(entry.Text)
		if text == "" {
			continue
		}
		message := transcriptMessage{
			ID: entry.ID, Seq: entry.Seq, Role: entry.Role, Kind: entry.Kind,
			Text: text, State: entry.State, CreatedAt: entry.CreatedAt,
		}
		if message.ID == "" {
			message.ID = "entry-" + formatSeq(entry.Seq)
		}
		messages = append(messages, message)
	}
	return messages, nil
}

func formatSeq(seq int64) string {
	if seq <= 0 {
		return "0"
	}
	digits := []byte{}
	for seq > 0 {
		digits = append([]byte{byte('0' + seq%10)}, digits...)
		seq /= 10
	}
	return string(digits)
}

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

func (s *shellState) openFleetAgentChat(agent fleetAgent) {
	if agent.ID == "" {
		return
	}
	selected := agent
	detail := func() { _ = s.openFleetAgentPage(selected) }
	if agent.ConversationID != "" {
		s.selectConversation(agent.ConversationID)
		s.chatMu.Lock()
		if s.chat != nil {
			s.chat.agentTitle = fleetAgentLabel(agent)
			s.chat.agentStatus = agent.Status
			s.chat.agentDetail = detail
		}
		s.chatMu.Unlock()
		s.frame()
		return
	}
	if agent.TaskID == "" || agent.NodeID == "" {
		return
	}
	state := newChatState(s.api.address, s.api.token)
	state.window = s.window
	state.agentTitle = fleetAgentLabel(agent)
	state.agentStatus = agent.Status
	state.agentDetail = detail
	state.openNode(agent)
	s.chatMu.Lock()
	s.activeID = state.active
	s.chat = state
	s.chatMu.Unlock()
	s.frame()
}
