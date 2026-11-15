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
	if label := workStatusOf(status).Label(); label != "" {
		return label
	}
	if strings.TrimSpace(status) == "" {
		return "未知"
	}
	return status
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

func fleetGroupKey(group fleetGroup) string {
	if group.Orphan {
		return "orphans"
	}
	return group.Project.ID
}

func joinFleetMeta(parts []string) string {
	out := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if out != "" {
			out += " · "
		}
		out += part
	}
	return out
}

func fleetAgentByID(data *fleetSnapshot, id string) (fleetAgent, bool) {
	if data == nil || id == "" {
		return fleetAgent{}, false
	}
	for _, agent := range data.Agents {
		if agent.ID == id {
			return agent, true
		}
	}
	return fleetAgent{}, false
}

func fleetAgentDurationMs(agent fleetAgent) int64 {
	if agent.UpdatedAt <= agent.CreatedAt {
		return 0
	}
	return agent.UpdatedAt - agent.CreatedAt
}

func fleetAgentSteps(agent fleetAgent) int {
	return agent.Requests
}

func fleetAgentShare(data *fleetSnapshot, agent fleetAgent) float64 {
	total := int64(0)
	for _, other := range data.Agents {
		if other.Tokens > 0 {
			total += other.Tokens
		}
	}
	if total <= 0 || agent.Tokens <= 0 {
		return 0
	}
	return float64(agent.Tokens) / float64(total)
}

func fleetAgentInitial(agent fleetAgent) string {
	for _, letter := range []rune(fleetAgentLabel(agent)) {
		return strings.ToUpper(string(letter))
	}
	return "?"
}

func fleetGroupIndex(data *fleetSnapshot, agent fleetAgent) int {
	if agent.Kind == "global" {
		return -1
	}
	for index, group := range fleetGroups(data) {
		if group.Orphan {
			continue
		}
		if group.Project.ID == agent.ID {
			return index
		}
		for _, child := range group.Agents {
			if child.ID == agent.ID {
				return index
			}
		}
	}
	return 0
}

func fleetTasksFor(data *fleetSnapshot, agent fleetAgent) []fleetTask {
	tasks := []fleetTask{}
	for _, task := range data.Tasks {
		if task.OwnerAgentID == agent.ID || (agent.Kind == "project" && agent.ProjectID != "" && task.ProjectID == agent.ProjectID) {
			tasks = append(tasks, task)
		}
	}
	return tasks
}

func fleetEventsFor(data *fleetSnapshot, agent fleetAgent) []fleetEvent {
	events := []fleetEvent{}
	for _, event := range data.Events {
		if event.AgentID == agent.ID || event.TargetAgentID == agent.ID {
			events = append(events, event)
		}
	}
	return events
}

func fleetArtifactsFor(data *fleetSnapshot, agent fleetAgent) []fleetArtifact {
	artifacts := []fleetArtifact{}
	for _, artifact := range data.Artifacts {
		if artifact.ProducerAgentID == agent.ID {
			artifacts = append(artifacts, artifact)
		}
	}
	return artifacts
}

func fleetParentOf(data *fleetSnapshot, agent fleetAgent) (fleetAgent, bool) {
	return fleetAgentByID(data, agent.ParentID)
}

func fleetChildrenOf(data *fleetSnapshot, agent fleetAgent) []fleetAgent {
	children := []fleetAgent{}
	for _, other := range data.Agents {
		if other.ParentID == agent.ID {
			children = append(children, other)
		}
	}
	return children
}

type fleetGraphUnit struct {
	TaskID    string
	ThreadID  string
	Title     string
	Status    string
	Detail    string
	Tokens    int64
	Cost      float64
	NodeCount int
	Agents    []fleetAgent
	UpdatedAt int64
	Total     int
	Aggregate bool
}

func fleetGraphUnits(data *fleetSnapshot) []fleetGraphUnit {
	units, _ := fleetGraphUnitData(data)
	return units
}

func fleetGraphTotals(data *fleetSnapshot) map[string]int {
	_, totals := fleetGraphUnitData(data)
	return totals
}

func fleetGraphUnitData(data *fleetSnapshot) ([]fleetGraphUnit, map[string]int) {
	if data == nil {
		return nil, nil
	}
	index := fleetIndex(data)
	byTask := map[string]*fleetGraphUnit{}
	order := []string{}
	threadOf := func(agent fleetAgent) string {
		if parent, ok := index[agent.ParentID]; ok && parent.Kind == "project" {
			return parent.ID
		}
		return "orphan"
	}
	for _, agent := range data.Agents {
		if agent.Kind != "node" && agent.Kind != "child" {
			continue
		}
		taskID := strings.TrimSpace(agent.TaskID)
		if taskID == "" {
			continue
		}
		unit, ok := byTask[taskID]
		if !ok {
			unit = &fleetGraphUnit{TaskID: taskID, ThreadID: threadOf(agent), Title: fleetGraphTitle(data, taskID)}
			byTask[taskID] = unit
			order = append(order, taskID)
		}
		unit.Agents = append(unit.Agents, agent)
		unit.NodeCount++
		unit.Tokens += agent.Tokens
		unit.Cost += agent.Cost
		if agent.UpdatedAt >= unit.UpdatedAt {
			unit.UpdatedAt = agent.UpdatedAt
			unit.Status = agent.Status
		}
	}
	totals := map[string]int{}
	groups := fleetGroups(data)
	threads := []string{}
	for _, group := range groups {
		if group.Orphan {
			threads = append(threads, "orphan")
			continue
		}
		threads = append(threads, group.Project.ID)
	}
	for _, unit := range byTask {
		totals[unit.ThreadID]++
	}
	current := []fleetGraphUnit{}
	for _, threadID := range threads {
		var active, terminal *fleetGraphUnit
		for _, taskID := range order {
			unit := byTask[taskID]
			if unit.ThreadID != threadID {
				continue
			}
			if workStatusOf(unit.Status).Terminal() {
				if terminal == nil || unit.UpdatedAt > terminal.UpdatedAt {
					terminal = unit
				}
				continue
			}
			if active == nil || unit.UpdatedAt > active.UpdatedAt {
				active = unit
			}
		}
		chosen := active
		if chosen == nil {
			chosen = terminal
		}
		if chosen == nil {
			continue
		}
		unit := *chosen
		unit.Total = totals[threadID]
		unit.Detail = fleetGraphDetail(data, unit)
		current = append(current, unit)
	}
	return current, totals
}

func fleetGraphTitle(data *fleetSnapshot, taskID string) string {
	if data != nil {
		for _, task := range data.Tasks {
			if task.ID != taskID && task.TaskID != taskID {
				continue
			}
			if title := strings.TrimSpace(task.Title); title != "" {
				runes := []rune(title)
				if len(runes) > 20 {
					title = string(runes[:20])
				}
				return title
			}
		}
	}
	if len(taskID) > 8 {
		return taskID[:8]
	}
	return taskID
}

func fleetGraphDetail(data *fleetSnapshot, unit fleetGraphUnit) string {
	names := []string{}
	for _, agent := range unit.Agents {
		if len(names) >= 5 {
			break
		}
		names = append(names, fleetAgentLabel(agent))
	}
	return fleetGraphTitle(data, unit.TaskID) + " · " + joinFleetMeta(names)
}
