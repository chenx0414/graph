package main

import (
	"strconv"
	"strings"
)

type fleetGroup struct {
	Project fleetAgent
	Agents  []fleetAgent
	Orphan  bool
}

func fleetIndex(data *fleetSnapshot) map[string]fleetAgent {
	index := make(map[string]fleetAgent, len(data.Agents))
	for _, agent := range data.Agents {
		index[agent.ID] = agent
	}
	return index
}

func fleetGlobals(data *fleetSnapshot) []fleetAgent {
	globals := []fleetAgent{}
	for _, agent := range data.Agents {
		if agent.Kind == "global" {
			globals = append(globals, agent)
		}
	}
	return globals
}

func fleetProjectOf(index map[string]fleetAgent, agent fleetAgent) (fleetAgent, bool) {
	seen := map[string]bool{}
	current := agent
	for steps := 0; steps < 64; steps++ {
		if current.Kind == "project" {
			return current, true
		}
		if current.ParentID == "" || seen[current.ParentID] {
			return fleetAgent{}, false
		}
		seen[current.ParentID] = true
		parent, ok := index[current.ParentID]
		if !ok {
			return fleetAgent{}, false
		}
		current = parent
	}
	return fleetAgent{}, false
}

func fleetGroups(data *fleetSnapshot) []fleetGroup {
	index := fleetIndex(data)
	groups := []fleetGroup{}
	at := map[string]int{}
	for _, agent := range data.Agents {
		if agent.Kind != "project" {
			continue
		}
		at[agent.ID] = len(groups)
		groups = append(groups, fleetGroup{Project: agent})
	}
	orphans := fleetGroup{Orphan: true}
	for _, agent := range data.Agents {
		if agent.Kind != "node" && agent.Kind != "child" {
			continue
		}
		if project, ok := fleetProjectOf(index, agent); ok {
			if group, found := at[project.ID]; found {
				groups[group].Agents = append(groups[group].Agents, agent)
				continue
			}
		}
		orphans.Agents = append(orphans.Agents, agent)
	}
	if len(orphans.Agents) > 0 {
		groups = append(groups, orphans)
	}
	return groups
}

func fleetGroupTitle(group fleetGroup) string {
	if group.Orphan {
		return "未归属"
	}
	return fleetAgentLabel(group.Project)
}

func fleetAgentLabel(agent fleetAgent) string {
	if name := strings.TrimSpace(agent.Name); name != "" {
		return name
	}
	if short := strings.TrimSpace(agent.Role); short != "" {
		return short
	}
	return agent.ID
}

func fleetAgentRole(agent fleetAgent) string {
	switch agent.Kind {
	case "global":
		return "全局主管"
	case "project":
		return "项目主管"
	case "child":
		return "子 Agent"
	}
	return "执行节点"
}

func fleetStatusLabel(status string) string {
	switch status {
	case "running":
		return "运行中"
	case "idle":
		return "空闲"
	case "completed", "done":
		return "完成"
	case "blocked":
		return "阻塞"
	case "failed":
		return "失败"
	case "stopped":
		return "已停止"
	}
	if status == "" {
		return "未知"
	}
	return status
}

func fleetFamilyOf(data *fleetSnapshot, id string) map[string]bool {
	family := map[string]bool{}
	if data == nil || id == "" {
		return family
	}
	index := fleetIndex(data)
	if _, ok := index[id]; !ok {
		return family
	}
	family[id] = true
	parentID := index[id].ParentID
	for steps := 0; parentID != "" && steps < 64; steps++ {
		family[parentID] = true
		parent, ok := index[parentID]
		if !ok {
			break
		}
		parentID = parent.ParentID
	}
	queue := []string{id}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, agent := range data.Agents {
			if agent.ParentID == current && !family[agent.ID] {
				family[agent.ID] = true
				queue = append(queue, agent.ID)
			}
		}
	}
	agent := index[id]
	if agent.Kind == "node" || agent.Kind == "child" {
		for _, candidate := range data.Agents {
			if candidate.ParentID == agent.ParentID && candidate.ID != id && !family[candidate.ID] {
				family[candidate.ID] = true
			}
		}
	}
	return family
}

func fleetEventCategory(event fleetEvent) string {
	kind := strings.ToLower(event.Type)
	switch {
	case strings.Contains(kind, "spawn"):
		return "spawn"
	case strings.Contains(kind, "deleg") || strings.Contains(kind, "assign"):
		return "delegate"
	case strings.Contains(kind, "deliver") || strings.Contains(kind, "about") ||
		strings.Contains(kind, "send") || strings.Contains(kind, "message") || strings.Contains(kind, "mail"):
		return "deliver"
	case strings.Contains(kind, "link"):
		return "delegate"
	case strings.Contains(kind, "result") || strings.Contains(kind, "reply") ||
		strings.Contains(kind, "complete") || strings.Contains(kind, "done"):
		return "result"
	case strings.Contains(kind, "question") || strings.Contains(kind, "ask") || strings.Contains(kind, "clarif"):
		return "question"
	}
	return "other"
}

func fleetCategoryLabel(category string) string {
	switch category {
	case "delegate":
		return "委派"
	case "spawn":
		return "派生"
	case "deliver":
		return "投递"
	case "result":
		return "结果"
	case "question":
		return "问题"
	}
	return "其他"
}

func fleetCategories() []string {
	return []string{"", "delegate", "spawn", "deliver", "result", "question", "other"}
}

func fleetFilteredEvents(data *fleetSnapshot, agentFilter, category string) []fleetEvent {
	events := []fleetEvent{}
	for _, event := range data.Events {
		if agentFilter != "" && event.AgentID != agentFilter && event.TargetAgentID != agentFilter {
			continue
		}
		if category != "" && fleetEventCategory(event) != category {
			continue
		}
		events = append(events, event)
	}
	return events
}

func fleetAgentName(index map[string]fleetAgent, id string) string {
	if id == "" {
		return "—"
	}
	if agent, ok := index[id]; ok {
		return fleetAgentLabel(agent)
	}
	return "未知 Agent"
}

func fleetEventLine(index map[string]fleetAgent, event fleetEvent) string {
	from := fleetAgentName(index, event.AgentID)
	to := fleetAgentName(index, event.TargetAgentID)
	text := strings.TrimSpace(event.Text)
	if text == "" {
		text = event.Type
	}
	if event.TargetAgentID == "" {
		return from + " · " + text
	}
	return from + " → " + to + " · " + text
}

func formatFleetCount(value int) string {
	digits := strconv.Itoa(value)
	out := make([]byte, 0, len(digits)+len(digits)/3)
	for index, digit := range digits {
		if index > 0 && (len(digits)-index)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, byte(digit))
	}
	return string(out)
}

func fleetOperation(agent fleetAgent) string {
	if activity := strings.TrimSpace(agent.Activity); activity != "" {
		return activity
	}
	if operation := strings.TrimSpace(agent.CurrentOperationID); operation != "" {
		return operation
	}
	return "—"
}

func fleetGroupExpanded(state *fleetState, group fleetGroup, total int) bool {
	key := group.Project.ID
	if group.Orphan {
		key = "orphans"
	}
	if open, ok := state.toggled[key]; ok {
		return open
	}
	return total <= fleetAutoExpand
}

func fleetGroupLimit(state *fleetState, group fleetGroup) int {
	key := group.Project.ID
	if group.Orphan {
		key = "orphans"
	}
	if limit, ok := state.windows[key]; ok && limit > fleetWindowStep {
		return limit
	}
	return fleetWindowStep
}
