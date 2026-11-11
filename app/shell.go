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
	project  string
	label    string
	id       string
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

type chatTab struct {
	title string
	id    string
	state *chatState
}

type shellState struct {
	api          apiClient
	status       string
	section      string
	newText      string
	newProject   string
	creating     bool
	showArchived bool
	activeID     string
	settings     *settingsState
	usage        *usageState
	resources    *resourceState
	rows         []sidebarRow
	broken       bool
	tabs         []*chatTab
	tabsMu       sync.Mutex
	window       *mygo.Window
	list         ui.ListState
}

func newShellState(address, token string) *shellState {
	return &shellState{api: newAPIClient(address, token), status: "正在读取会话…"}
}

func (s *shellState) setSection(name string) {
	s.tabsMu.Lock()
	s.section = name
	s.tabsMu.Unlock()
}

func (s *shellState) currentSection() string {
	s.tabsMu.Lock()
	defer s.tabsMu.Unlock()
	return s.section
}

func (s *shellState) active() *chatState {
	s.tabsMu.Lock()
	defer s.tabsMu.Unlock()
	for _, tab := range s.tabs {
		if tab.id == s.activeID {
			return tab.state
		}
	}
	return nil
}

func (s *shellState) activeTabID() string {
	s.tabsMu.Lock()
	defer s.tabsMu.Unlock()
	return s.activeID
}

func (s *shellState) setActiveTab(id string) {
	s.tabsMu.Lock()
	s.activeID = id
	s.tabsMu.Unlock()
}

func (s *shellState) tabSnapshot() ([]*chatTab, string) {
	s.tabsMu.Lock()
	defer s.tabsMu.Unlock()
	return append([]*chatTab(nil), s.tabs...), s.activeID
}

func (s *shellState) postJSON(path string, body any) error {
	_, err := s.api.post(path, body)
	return err
}

type errStatus string

func (e errStatus) Error() string { return "服务端拒绝：" + string(e) }

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
	s.closeTab(id)
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

func (s *shellState) openSettings() {
	if s.settings == nil {
		s.settings = newSettingsState(s.api.address, s.api.token)
		s.settings.window = s.window
		go s.settings.load()
	}
	s.setSection("settings")
	s.frame()
}

func (s *shellState) openUsage() {
	if s.usage == nil {
		s.usage = newUsageState(s.api.address, s.api.token)
		s.usage.window = s.window
		go s.usage.load()
	}
	s.setSection("usage")
	s.frame()
}

func (s *shellState) openResources() {
	if s.resources == nil {
		s.resources = newResourceState(s.api.address, s.api.token)
		s.resources.window = s.window
		go s.resources.load()
	}
	s.setSection("resources")
	s.frame()
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
	s.setSection("chat")
	if s.activateTab(id) {
		s.frame()
		return
	}
	state := newChatState(s.api.address, s.api.token)
	state.window = s.window
	state.open(id)
	s.attachTab(id, state)
	s.frame()
}

func (s *shellState) activateTab(id string) bool {
	s.tabsMu.Lock()
	defer s.tabsMu.Unlock()
	for _, tab := range s.tabs {
		if tab.id == id {
			s.activeID = id
			return true
		}
	}
	return false
}

func (s *shellState) attachTab(id string, state *chatState) bool {
	title := s.titleOf(id)
	s.tabsMu.Lock()
	defer s.tabsMu.Unlock()
	for _, tab := range s.tabs {
		if tab.id == id {
			s.activeID = id
			return false
		}
	}
	s.tabs = append(s.tabs, &chatTab{id: id, title: title, state: state})
	s.activeID = id
	return true
}

func (s *shellState) closeTab(id string) {
	s.tabsMu.Lock()
	kept := make([]*chatTab, 0, len(s.tabs))
	for _, tab := range s.tabs {
		if tab.id != id {
			kept = append(kept, tab)
		}
	}
	s.tabs = kept
	if s.activeID == id {
		s.activeID = ""
		if len(s.tabs) > 0 {
			s.activeID = s.tabs[len(s.tabs)-1].id
		}
	}
	s.tabsMu.Unlock()
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

func (s *shellState) view(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Row(ctx).Fill().Children(func() {
		ui.Column(ctx).Width(240).Fill().Padding(12).Gap(6).BorderWidth(0, 0, 0, 1).BorderColor(t.Border).Children(func() {
			ui.Text(ctx, "Graph").FontSize(14)
			ui.Row(ctx).Gap(4).Children(func() {
				if ui.Button(ctx, "会话").Clicked() {
					s.setSection("chat")
				}
				if ui.Button(ctx, "设置").Clicked() {
					go s.openSettings()
				}
				if ui.Button(ctx, "用量").Clicked() {
					go s.openUsage()
				}
				if ui.Button(ctx, "资源").Clicked() {
					go s.openResources()
				}
			})
			ui.Row(ctx).Gap(4).Children(func() {
				if ui.Button(ctx, "新建会话").Clicked() {
					s.creating = true
					s.setSection("chat")
				}
				label := "显示已归档"
				if s.showArchived {
					label = "隐藏已归档"
				}
				if ui.Button(ctx, label).Clicked() {
					s.showArchived = !s.showArchived
					s.load()
				}
			})
			if s.creating {
				ui.Column(ctx).Gap(4).Children(func() {
					ui.Row(ctx).Gap(4).Children(func() {
						projects := s.projectNames()
						for _, project := range projects {
							label := project
							if s.newProject == project {
								label = "• " + label
							}
							if ui.Button(ctx, label).Clicked() {
								if s.newProject == project {
									s.newProject = ""
								} else {
									s.newProject = project
								}
							}
						}
					})
					ui.TextInput(ctx, &s.newText).Placeholder("第一条消息（可留空）").Label("新会话内容")
					ui.Row(ctx).Gap(4).Children(func() {
						if ui.PrimaryButton(ctx, "创建").Clicked() {
							go s.createConversation()
						}
						if ui.Button(ctx, "取消创建").Clicked() {
							s.creating = false
							s.newText = ""
						}
					})
				})
			}
			if s.status != "" {
				ui.Text(ctx, s.status).FontSize(12).TextColor(t.TextMuted)
				return
			}
			ui.List(ctx, &s.list, len(s.rows), func(index int) {
				row := s.rows[index]
				if row.id == "" {
					ui.Text(ctx, row.project).FontSize(11).TextColor(t.TextMuted)
					return
				}
				label := row.label
				if row.id == s.activeTabID() {
					label = "• " + label
				}
				if ui.Button(ctx, label).Clicked() {
					target := row.id
					if row.archived {
						go s.unarchiveConversation(target)
						return
					}
					go s.selectConversation(target)
				}
			}).Grow(1)
		})
		section := s.currentSection()
		ui.Column(ctx).Fill().Children(func() {
			if section == "resources" {
				if s.resources == nil {
					ui.Text(ctx, "正在读取能力库…").Padding(16).TextColor(t.TextMuted)
					return
				}
				s.resources.view(ctx)
				return
			}
			if section == "usage" {
				if s.usage == nil {
					ui.Text(ctx, "正在汇总用量…").Padding(16).TextColor(t.TextMuted)
					return
				}
				s.usage.view(ctx)
				return
			}
			if section == "settings" {
				if s.settings == nil {
					ui.Text(ctx, "正在读取设置…").Padding(16).TextColor(t.TextMuted)
					return
				}
				s.settings.view(ctx)
				return
			}
			tabs, activeTab := s.tabSnapshot()
			if len(tabs) > 0 {
				ui.Row(ctx).Gap(4).Padding(8, 8, 0, 8).Children(func() {
					for _, tab := range tabs {
						label := tab.title
						if tab.id == activeTab {
							label = "› " + label
						}
						if ui.Button(ctx, label).Clicked() {
							s.setActiveTab(tab.id)
						}
						if ui.Button(ctx, "关闭 "+tab.title).Clicked() {
							s.closeTab(tab.id)
						}
						if tab.id == activeTab && ui.Button(ctx, "归档 "+tab.title).Clicked() {
							go s.archiveConversation(tab.id)
						}
					}
				})
			}
			active := s.active()
			if active == nil {
				ui.Text(ctx, "从左侧选择一个会话").Padding(16).TextColor(t.TextMuted)
				return
			}
			active.view(ctx)
		})
	})
}
