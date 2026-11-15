package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type composerMenuItem struct {
	id          string
	label       string
	description string
	badge       string
	icon        *ui.SVG
	value       string
}

type composerPathEntry struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type composerSkillEntry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Version string `json:"version"`
	Source  string `json:"source"`
	Ready   bool   `json:"ready"`
}

var composerCommands = []composerMenuItem{
	{id: "new", label: "/new", description: "新开一个 Agent 上下文（清空模型上下文）", badge: "命令", icon: iconRefresh},
	{id: "attach", label: "/attach", description: "附加本地文件", badge: "命令", icon: iconClip},
	{id: "model", label: "/model", description: "在白板的模型页切换模型", badge: "命令", icon: iconSpark},
}

func parseComposerPaths(payload []byte) []composerPathEntry {
	var listed struct {
		Entries []composerPathEntry `json:"entries"`
	}
	if json.Unmarshal(payload, &listed) != nil {
		return nil
	}
	return listed.Entries
}

func parseComposerSkills(payload []byte) []composerSkillEntry {
	var listed struct {
		Items []composerSkillEntry `json:"items"`
	}
	if json.Unmarshal(payload, &listed) != nil {
		return nil
	}
	skills := make([]composerSkillEntry, 0, len(listed.Items))
	for _, item := range listed.Items {
		if item.Kind == "skill" && item.ID != "" {
			skills = append(skills, item)
		}
	}
	sort.SliceStable(skills, func(a, b int) bool { return skills[a].Name < skills[b].Name })
	return skills
}

func composerMatches(query string, fields ...string) bool {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return true
	}
	for _, field := range fields {
		if strings.Contains(strings.ToLower(field), query) {
			return true
		}
	}
	return false
}

func (c *chatState) composerMenuItems(trigger *composerTrigger) []composerMenuItem {
	if trigger == nil {
		return nil
	}
	switch trigger.kind {
	case "path":
		items := make([]composerMenuItem, 0, len(c.pathItems))
		for _, entry := range c.pathItems {
			label := entry.Path
			if index := strings.LastIndex(entry.Path, "/"); index >= 0 {
				label = entry.Path[index+1:]
			}
			badge := "文件"
			if entry.Kind == "directory" {
				badge = "目录"
			}
			items = append(items, composerMenuItem{id: entry.Path, label: label, description: entry.Path, badge: badge, icon: iconDoc, value: entry.Path})
		}
		return items
	case "skill":
		items := make([]composerMenuItem, 0, len(c.skillItems))
		for _, skill := range c.skillItems {
			if !composerMatches(trigger.query, skill.Name, skill.ID) {
				continue
			}
			label := skill.Name
			if label == "" {
				label = skill.ID
			}
			description := "技能注入"
			if skill.Version != "" && skill.Version != "local" {
				description = "技能 · v" + skill.Version
			}
			badge := "技能"
			if strings.Contains(skill.Source, "/agents/") {
				badge = "项目技能"
			}
			name := skill.Name
			if name == "" {
				name = skill.ID
			}
			items = append(items, composerMenuItem{id: skill.ID, label: "$" + label, description: description, badge: badge, icon: iconSpark, value: "/skill:" + name + " "})
		}
		return items
	case "command":
		items := make([]composerMenuItem, 0, len(composerCommands))
		for _, command := range composerCommands {
			if composerMatches(trigger.query, command.label, command.description) {
				items = append(items, command)
			}
		}
		return items
	}
	return nil
}

func (c *chatState) composerMenuEmptyText(trigger *composerTrigger) string {
	switch trigger.kind {
	case "path":
		if c.pathLoading {
			return "正在搜索工作区文件…"
		}
		if c.projectID == "" {
			return "这个会话没有关联项目，@ 需要先打开项目会话。"
		}
		return "没有匹配的文件或目录。"
	case "skill":
		if c.skillsLoading {
			return "正在读取技能…"
		}
		return "没有匹配的技能。用 / 浏览命令。"
	}
	return "没有匹配的命令。"
}

func (c *chatState) ensureComposerPaths() {
	if c.menuTrigger == nil || c.menuTrigger.kind != "path" || c.projectID == "" {
		return
	}
	query := strings.TrimSpace(c.menuTrigger.query)
	key := c.projectID + "\x00" + query
	if c.pathQuery == key || c.pathLoading {
		return
	}
	c.pathQuery = key
	c.pathLoading = true
	projectID, api := c.projectID, c.api
	go func() {
		payload, err := api.get("/api/projects/" + url.PathEscape(projectID) + "/entries?q=" + url.QueryEscape(query) + "&limit=20")
		var entries []composerPathEntry
		if err == nil {
			entries = parseComposerPaths(payload)
		}
		onUI(c.window, func() {
			if c.pathQuery != key {
				return
			}
			c.pathLoading = false
			c.pathItems = entries
			c.frame()
		})
	}()
}

func (c *chatState) ensureComposerSkills() {
	if len(c.skillItems) > 0 || c.skillsLoading {
		return
	}
	c.skillsLoading = true
	api := c.api
	go func() {
		payload, err := api.get("/api/capabilities/config")
		var skills []composerSkillEntry
		if err == nil {
			skills = parseComposerSkills(payload)
		}
		onUI(c.window, func() {
			c.skillsLoading = false
			c.skillItems = skills
			c.frame()
		})
	}()
}

func (c *chatState) composerMenuView(ctx *ui.Context, items []composerMenuItem) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	surface := ui.Column(ctx).FillWidth().MaxHeight(th.Space(72)).PaddingY(th.Space(1.5)).
		Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).Background(t.Card).Clip()
	kit.Elevate(ctx, surface, composerShadow)
	surface.Children(func() {
		ui.Scroll(ctx).Grow(1).Children(func() {
			if len(items) == 0 {
				kit.Text(ctx, c.composerMenuEmptyText(c.menuTrigger), t.Text.Xs).TextColor(t.Muted).
					Padding(th.Space(3.5), th.Space(5))
				return
			}
			for index, item := range items {
				current := item
				active := index == c.menuActive
				row := ui.Row(ctx).FillWidth().Height(th.Space(7)).PaddingX(th.Space(2)).Gap(th.Space(2)).
					AlignItems(ui.Center).Radius(t.Radius.Lg).Label(current.label)
				if active {
					row.Background(t.Hover)
				}
				row.Children(func() {
					ui.Icon(ctx, current.icon).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
					kit.Text(ctx, current.label, t.Text.Sm).FontWeight(500).SingleLine().Ellipsis("…").MaxWidthPercent(45)
					kit.Text(ctx, current.description, t.Text.Sm).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
					if current.badge != "" {
						badge := ui.Row(ctx).PaddingX(th.Space(1.5)).PaddingY(th.Space(0.5)).Radius(t.Radius.Full).
							Background(t.Hover).AlignItems(ui.Center)
						badge.Children(func() {
							kit.Text(ctx, current.badge, t.Text.Xs).TextColor(t.Muted).SingleLine()
						})
					}
				})
				row.OnClick(func() { c.composerSelect(current) })
			}
		})
	})
}

func (c *chatState) composerSelect(item composerMenuItem) {
	trigger := c.menuTrigger
	if trigger == nil {
		return
	}
	if item.id == "new" {
		c.draft = ""
		c.menuTrigger = nil
		c.menuDismissed = ""
		c.focusComposer = true
		c.status = "正在开启新的 Agent 上下文…"
		c.frame()
		go c.newAgentContext()
		return
	}
	if item.id == "attach" {
		c.menuTrigger = nil
		c.menuDismissed = ""
		c.pickAttachment()
		return
	}
	if item.id == "model" {
		c.menuTrigger = nil
		c.menuDismissed = ""
		c.status = "模型切换在白板的模型页"
		c.frame()
		return
	}
	replacement := item.value
	if item.badge == "目录" || item.badge == "文件" {
		replacement = composerFileLink(item.value)
	}
	draft, cursor := composerReplaceRange(c.draft, trigger.start, trigger.end, replacement)
	c.draft = draft
	c.pendingCaret = cursor
	c.menuTrigger = nil
	c.menuDismissed = ""
	c.menuActive = 0
	c.focusComposer = true
	c.frame()
}

func (c *chatState) composerMenuKey(k ui.TextKey) bool {
	if c.menuTrigger == nil {
		return false
	}
	items := c.composerMenuItems(c.menuTrigger)
	switch k.Key {
	case ui.KeyUp:
		if len(items) > 0 {
			c.menuActive--
			if c.menuActive < 0 {
				c.menuActive = len(items) - 1
			}
		}
		return true
	case ui.KeyDown:
		if len(items) > 0 {
			c.menuActive++
			if c.menuActive >= len(items) {
				c.menuActive = 0
			}
		}
		return true
	case ui.KeyEscape:
		c.menuDismissed = c.draft
		c.menuTrigger = nil
		return true
	case ui.KeyEnter, ui.KeyTab:
		if len(items) == 0 {
			return false
		}
		if c.menuActive < 0 || c.menuActive >= len(items) {
			c.menuActive = 0
		}
		c.composerSelect(items[c.menuActive])
		return true
	}
	return false
}
