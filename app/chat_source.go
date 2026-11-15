package main

import (
	"encoding/json"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type chatCapabilities struct {
	ModelChip   bool
	Pause       bool
	History     bool
	Attachments bool
}

type agentChatSource interface {
	Key() string
	Scope() chatScope
	Capabilities() chatCapabilities
	Load(c *chatState) error
	Refresh(c *chatState) (bool, error)
	Send(c *chatState, text string) error
	LoadOlder(c *chatState, before int64) ([]transcriptMessage, int64, bool, error)
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
func (source *conversationChatSource) Scope() chatScope {
	return chatScope{Kind: "conversation", ConversationID: source.id}
}
func (source *conversationChatSource) Capabilities() chatCapabilities {
	return chatCapabilities{ModelChip: true, Pause: true, History: true, Attachments: true}
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
	messages = applyLiveStreams(messages, payload)
	c.messages = messages
	c.roundMaster = parseRoundMaster(payload)
	c.projectID, c.projectRoot = parseConversationScope(payload)
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
	if !c.refreshMu.TryLock() {
		return false, nil
	}
	defer c.refreshMu.Unlock()
	payload, err := source.api.get("/api/conversations/" + source.id)
	if err != nil {
		return false, err
	}
	messages, err := parseConversationMessages(payload)
	if err != nil {
		return false, err
	}
	live := applyLiveStreams(messages, payload)
	fingerprint := transcriptFingerprint(live)
	master := parseRoundMaster(payload)
	body, bodyErr := parseConversationBody(payload)
	tasks, tasksErr := parseGraphTasks(payload)
	changed := false
	onUI(c.window, func() {
		if c.source != source {
			return
		}
		changed = fingerprint != c.fingerprint
		c.fingerprint = fingerprint
		changed = changed || master != c.roundMaster
		c.roundMaster = master
		c.projectID, c.projectRoot = parseConversationScope(payload)
		if c.pagedHistory {
			c.messages = applyLiveStreams(mergeMessages(c.messages, messages), payload)
		} else {
			c.messages = live
		}
		if bodyErr == nil {
			var questions []openQuestion
			for _, question := range body.Questions {
				if question.open() {
					questions = append(questions, question)
				}
			}
			changed = changed || body.Paused != c.paused || !reflect.DeepEqual(questions, c.questions)
			c.paused = body.Paused
			c.questions = questions
		}
		if tasksErr == nil {
			changed = changed || !reflect.DeepEqual(tasks, c.tasks)
			c.tasks = tasks
		}
		if c.status == chatWaitStatus && roundAnswered(c.messages) && !c.roundPhase().busy() {
			changed = true
			c.status = ""
		}
	})
	return changed, nil
}

func (source *conversationChatSource) LoadOlder(c *chatState, before int64) ([]transcriptMessage, int64, bool, error) {
	payload, err := source.api.get("/api/conversations/" + source.id + "/history?before=" + itoa64(before) + "&limit=" + itoa64(historyPageSize))
	if err != nil {
		return nil, 0, false, err
	}
	raw, err := parseConversationRaw(payload)
	if err != nil {
		return nil, 0, false, err
	}
	kept, err := parseConversationMessages(payload)
	if err != nil {
		return nil, 0, false, err
	}
	raw = olderBefore(raw, before)
	kept = olderBefore(kept, before)
	return kept, oldestSeqOf(raw), len(raw) >= historyPageSize, nil
}

func (source *conversationChatSource) Send(c *chatState, text string) error {
	body := map[string]any{"text": text, "requestId": "native-" + time.Now().Format("150405.000000")}
	if len(c.attachments) > 0 {
		attachments := make([]map[string]any, 0, len(c.attachments))
		for _, attachment := range c.attachments {
			record := map[string]any{
				"name": attachment.Name,
				"type": attachment.Type,
				"size": attachment.Size,
				"text": attachment.Text,
			}
			if attachment.isImage() {
				record["data"] = attachment.Data
			}
			attachments = append(attachments, record)
		}
		body["attachments"] = attachments
	}
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
func (source *nodeChatSource) Scope() chatScope {
	return chatScope{Kind: "node", TaskID: source.taskID, NodeID: source.nodeID}
}
func (source *nodeChatSource) Capabilities() chatCapabilities {
	return chatCapabilities{History: true}
}
func (source *nodeChatSource) Follows() bool { return false }

func (source *nodeChatSource) path(suffix string) string {
	return "/api/tasks/" + url.PathEscape(source.taskID) + "/nodes/" + url.PathEscape(source.nodeID) + suffix
}

func (source *nodeChatSource) Load(c *chatState) error {
	messages, hasOlder, err := source.loadPage(0)
	if err != nil {
		c.status = "读不到这个节点的记录：" + err.Error()
		return err
	}
	for page := 0; page < 5 && hasOlder && !nodeEntriesHaveMessage(messages); page++ {
		before := oldestSeqOf(messages)
		if before <= 0 {
			break
		}
		older, olderHas, err := source.loadPage(before)
		if err != nil {
			c.status = "读不到这个节点的记录：" + err.Error()
			return err
		}
		if len(older) == 0 {
			break
		}
		messages = mergeMessages(older, messages)
		hasOlder = olderHas
	}
	c.messages = messages
	c.fingerprint = transcriptFingerprint(messages)
	c.oldestSeq = oldestSeqOf(messages)
	c.noMoreHistory = !hasOlder || c.oldestSeq <= 0
	c.questions = nil
	source.loadScopeData(c)
	if len(messages) == 0 {
		c.status = "这个节点还没有可显示的记录。"
		return nil
	}
	c.status = ""
	return nil
}

func (source *nodeChatSource) loadPage(before int64) ([]transcriptMessage, bool, error) {
	query := "?limit=" + itoa64(historyPageSize)
	if before > 0 {
		query += "&before=" + itoa64(before)
	}
	payload, err := source.api.get(source.path("/run") + query)
	if err != nil {
		return nil, false, err
	}
	return parseNodeRunEntries(payload)
}

func nodeEntriesHaveMessage(messages []transcriptMessage) bool {
	for _, message := range messages {
		if message.Role == "user" || message.Role == "assistant" || message.Role == "system" || message.Role == "error" {
			return true
		}
	}
	return false
}

func (source *nodeChatSource) Refresh(c *chatState) (bool, error) {
	messages, _, err := source.loadPage(0)
	if err != nil {
		return false, err
	}
	if err != nil {
		return false, err
	}
	fingerprint := transcriptFingerprint(messages)
	source.loadScopeData(c)
	if fingerprint == c.fingerprint {
		return false, nil
	}
	c.fingerprint = fingerprint
	if c.pagedHistory {
		c.messages = mergeMessages(messages, c.messages)
	} else {
		c.messages = messages
	}
	return true, nil
}

func (source *nodeChatSource) loadScopeData(c *chatState) {
	c.tasks = nil
	if payload, err := source.api.get("/api/tasks/" + url.PathEscape(source.taskID)); err == nil {
		if rows, err := parseTaskViewRows(payload); err == nil {
			c.tasks = rows
		}
	}
	c.artifacts = nil
	if payload, err := source.api.get("/api/tasks/" + url.PathEscape(source.taskID) + "/artifacts"); err == nil {
		if rows, err := parseArtifacts(payload); err == nil {
			c.artifacts = artifactsOfNode(rows, source.nodeID)
		}
	}
}

func (source *nodeChatSource) LoadOlder(c *chatState, before int64) ([]transcriptMessage, int64, bool, error) {
	payload, err := source.api.get(source.path("/run") + "?before=" + itoa64(before) + "&limit=" + itoa64(historyPageSize))
	if err != nil {
		return nil, 0, false, err
	}
	messages, hasOlder, err := parseNodeRunEntries(payload)
	if err != nil {
		return nil, 0, false, err
	}
	kept := make([]transcriptMessage, 0, len(messages))
	for _, message := range messages {
		if message.Seq > 0 && message.Seq < before {
			kept = append(kept, message)
		}
	}
	return kept, oldestSeqOf(kept), hasOlder, nil
}

func (source *nodeChatSource) Send(c *chatState, text string) error {
	body := map[string]string{"text": text, "requestId": requestID("node-chat")}
	_, err := source.api.post(source.path("/messages"), body)
	return err
}

func (s *shellState) activeChatCapabilities() chatCapabilities {
	chat := s.active()
	if chat == nil || chat.source == nil {
		return chatCapabilities{ModelChip: true, Pause: true, History: true, Attachments: true}
	}
	return chat.source.Capabilities()
}

func (s *shellState) installAgentChat(source agentChatSource, agent fleetAgent) {
	state := newChatState(s.api.address, s.api.token)
	state.window = s.window
	state.providerOn = s.providersEnabled
	if agent.ID != "" {
		state.agentTitle = fleetAgentLabel(agent)
		state.agentStatus = agent.Status
	}
	state.openSource(source)
	s.chatMu.Lock()
	s.activeID = state.active
	s.chat = state
	s.chatMu.Unlock()
	s.frame()
}

func stripSpace(text string) string { return strings.TrimSpace(text) }

func itoa64(value int64) string { return strconv.FormatInt(value, 10) }

func parseConversationScope(payload []byte) (string, string) {
	var scope struct {
		ProjectID   string `json:"projectId"`
		ProjectRoot string `json:"projectRoot"`
	}
	if json.Unmarshal(payload, &scope) != nil {
		return "", ""
	}
	return scope.ProjectID, scope.ProjectRoot
}
