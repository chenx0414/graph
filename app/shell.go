package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type conversationGroup struct {
	project string
	items   []conversationSummary
}

func groupByProject(list []conversationSummary) []conversationGroup {
	groups := []conversationGroup{}
	at := map[string]int{}
	for _, conversation := range list {
		if conversation.ArchivedAtPresent() {
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
}

func sidebarRows(groups []conversationGroup) []sidebarRow {
	rows := []sidebarRow{}
	for _, group := range groups {
		rows = append(rows, sidebarRow{project: group.project})
		for _, conversation := range group.items {
			label := strings.TrimSpace(conversation.Title)
			if label == "" {
				label = "（无标题）"
			}
			if conversation.OpenQuestions > 0 {
				label += " · " + strconv.Itoa(conversation.OpenQuestions) + " 待答"
			}
			rows = append(rows, sidebarRow{label: label, id: conversation.ID})
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
	address  string
	token    string
	status   string
	activeID string
	rows     []sidebarRow
	tabs     []*chatTab
	window   *mygo.Window
	list     ui.ListState
}

func newShellState(address, token string) *shellState {
	return &shellState{address: address, token: token, status: "正在读取会话…"}
}

func (s *shellState) active() *chatState {
	for _, tab := range s.tabs {
		if tab.id == s.activeID {
			return tab.state
		}
	}
	return nil
}

func (s *shellState) load() {
	payload, err := daemonGet(s.address, s.token, "/api/conversations")
	if err != nil {
		s.status = "读不到会话列表：" + err.Error()
		return
	}
	list, err := parseConversations(payload)
	if err != nil {
		s.status = "会话列表不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = sidebarRows(groupByProject(list))
	if len(s.rows) == 0 {
		s.status = "还没有会话。"
		return
	}
	s.status = ""
	for _, row := range s.rows {
		if row.id != "" {
			s.selectConversation(row.id)
			return
		}
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
	for _, tab := range s.tabs {
		if tab.id == id {
			s.activeID = id
			s.frame()
			return
		}
	}
	state := newChatState(s.address, s.token)
	state.window = s.window
	state.open(id)
	s.tabs = append(s.tabs, &chatTab{id: id, title: s.titleOf(id), state: state})
	s.activeID = id
	s.frame()
}

func (s *shellState) closeTab(id string) {
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
	s.frame()
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
				if row.id == s.activeID {
					label = "• " + label
				}
				if ui.Button(ctx, label).Clicked() {
					target := row.id
					go s.selectConversation(target)
				}
			}).Grow(1)
		})
		ui.Column(ctx).Fill().Children(func() {
			if len(s.tabs) > 0 {
				ui.Row(ctx).Gap(4).Padding(8, 8, 0, 8).Children(func() {
					for _, tab := range s.tabs {
						label := tab.title
						if tab.id == s.activeID {
							label = "› " + label
						}
						if ui.Button(ctx, label).Clicked() {
							s.activeID = tab.id
						}
						if ui.Button(ctx, "关闭 "+tab.title).Clicked() {
							s.closeTab(tab.id)
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
