package main

import (
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type conversationGroup struct {
	project string
	items   []conversationSummary
}

func groupByProject(list []conversationSummary) []conversationGroup {
	return groupByProjectIncludingArchived(list, false)
}

func groupByProjectIncludingArchived(list []conversationSummary, includeArchived bool) []conversationGroup {
	groups := []conversationGroup{}
	at := map[string]int{}
	for _, conversation := range list {
		if conversation.Role == "global" {
			continue
		}
		if conversation.ArchivedAtPresent() && !includeArchived {
			continue
		}
		project := strings.TrimSpace(conversation.ProjectID)
		if project == "" {
			project = "未分组"
		}
		if index, ok := at[project]; ok {
			groups[index].items = append(groups[index].items, conversation)
			continue
		}
		at[project] = len(groups)
		groups = append(groups, conversationGroup{project: project, items: []conversationSummary{conversation}})
	}
	return groups
}

type sidebarRow struct {
	project string
	label   string
	id      string
	archived bool
}

func sidebarRows(groups []conversationGroup) []sidebarRow {
	rows := []sidebarRow{}
	for _, group := range groups {
		rows = append(rows, sidebarRow{project: group.project})
		for _, conversation := range group.items {
			archived := conversation.ArchivedAtPresent()
			label := strings.TrimSpace(conversation.Title)
			if label == "" {
				label = "（无标题）"
			}
			if conversation.Role == "project" {
				label = "项目主管 · " + label
			}
			if conversation.OpenQuestions > 0 {
				label += " · " + strconv.Itoa(conversation.OpenQuestions) + " 待答"
			}
			if archived {
				label += "（已归档）"
			}
			rows = append(rows, sidebarRow{label: label, id: conversation.ID, archived: archived})
		}
	}
	return rows
}

type shellState struct {
	api           apiClient
	status        string
	newText       string
	newProject    string
	creating      bool
	showArchived  bool
	activeID      string
	chatMu        sync.Mutex
	chat          *chatState
	settings      *settingsState
	usage         *usageState
	resources     *resourceState
	rows          []sidebarRow
	conversations []conversationSummary
	supervisorID  string
	broken        bool
	board         boardState
	window        *mygo.Window
	list          ui.ListState
}

func newShellState(address, token string) *shellState {
	return &shellState{
		api:    newAPIClient(address, token),
		status: "正在读取会话…",
		board:  boardState{mode: boardHome, grid: true},
	}
}

func (s *shellState) active() *chatState {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	return s.chat
}

func (s *shellState) postJSON(path string, body any) error {
	_, err := s.api.post(path, body)
	return err
}

func requestID(prefix string) string {
	return prefix + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func (s *shellState) createConversation() {
	body := map[string]any{"requestId": requestID("native-new")}
	if text := strings.TrimSpace(s.newText); text != "" {
		body["text"] = text
	}
	if project := strings.TrimSpace(s.newProject); project != "" {
		body["projectId"] = project
	}
	if err := s.postJSON("/api/conversations", body); err != nil {
		s.status = "新建会话失败：" + err.Error()
		s.frame()
		return
	}
	s.creating = false
	s.newText = ""
	s.newProject = ""
	s.status = ""
	s.load()
	s.frame()
}

func (s *shellState) archiveConversation(id string) {
	if err := s.postJSON("/api/conversations/"+id+"/archive", map[string]any{"requestId": requestID("native-archive")}); err != nil {
		s.status = "归档失败：" + err.Error()
		s.frame()
		return
	}
	s.chatMu.Lock()
	if s.activeID == id {
		s.activeID = ""
		s.chat = nil
	}
	s.chatMu.Unlock()
	s.load()
	s.frame()
}

func (s *shellState) unarchiveConversation(id string) {
	if err := s.postJSON("/api/conversations/"+id+"/unarchive", map[string]any{"requestId": requestID("native-unarchive")}); err != nil {
		s.status = "取消归档失败：" + err.Error()
		s.frame()
		return
	}
	s.load()
	s.frame()
}

func (s *shellState) adoptConsole(paths Paths) bool {
	info, ok := paths.ReadConsole()
	if !ok || info.URL == "" || info.URL == s.api.address {
		return false
	}
	s.api = newAPIClient(info.URL, paths.SessionToken())
	s.broken = true
	return true
}

func (s *shellState) loadRows() bool {
	payload, err := s.api.get("/api/conversations")
	if err != nil {
		s.status = "读不到会话列表：" + err.Error()
		s.broken = true
		return false
	}
	list, err := parseConversations(payload)
	if err != nil {
		s.status = "会话列表不是预期的 JSON：" + err.Error()
		s.broken = true
		return false
	}
	s.conversations = list
	s.supervisorID = ""
	for _, conversation := range list {
		if conversation.Role == "global" && s.supervisorID == "" {
			s.supervisorID = conversation.ID
		}
	}
	s.rows = sidebarRows(groupByProjectIncludingArchived(list, s.showArchived))
	s.broken = false
	if len(s.rows) == 0 {
		s.status = "还没有会话。"
		return true
	}
	s.status = ""
	return true
}

func (s *shellState) load() {
	if !s.loadRows() {
		return
	}
	for _, row := range s.rows {
		if row.id != "" {
			s.selectConversation(row.id)
			return
		}
	}
}

func (s *shellState) projectNames() []string {
	names := []string{}
	seen := map[string]bool{}
	for _, row := range s.rows {
		if row.id != "" || row.project == "" || row.project == "未分组" || seen[row.project] {
			continue
		}
		seen[row.project] = true
		names = append(names, row.project)
	}
	return names
}

func (s *shellState) ensureSettings() {
	if s.settings == nil {
		s.settings = newSettingsState(s.api.address, s.api.token)
		s.settings.window = s.window
		go s.settings.load()
	}
}

func (s *shellState) ensureUsage() {
	if s.usage == nil {
		s.usage = newUsageState(s.api.address, s.api.token)
		s.usage.window = s.window
		go s.usage.load()
	}
}

func (s *shellState) ensureResources() {
	if s.resources == nil {
		s.resources = newResourceState(s.api.address, s.api.token)
		s.resources.window = s.window
		go s.resources.load()
	}
}

func (s *shellState) titleOf(id string) string {
	for _, row := range s.rows {
		if row.id == id {
			return row.label
		}
	}
	return "（无标题）"
}

func (s *shellState) selectConversation(id string) {
	if strings.TrimSpace(id) == "" {
		return
	}
	s.chatMu.Lock()
	if s.activeID == id {
		s.chatMu.Unlock()
		return
	}
	s.activeID = id
	s.chat = nil
	s.chatMu.Unlock()
	state := newChatState(s.api.address, s.api.token)
	state.window = s.window
	state.open(id)
	s.chatMu.Lock()
	if s.activeID == id {
		s.chat = state
	}
	s.chatMu.Unlock()
	s.frame()
}

func (s *shellState) refresh() bool {
	changed := false
	if active := s.active(); active != nil {
		changed = active.poll()
	}
	if (s.broken || len(s.rows) == 0) && s.loadRows() {
		changed = true
	}
	return changed
}

func (s *shellState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}
