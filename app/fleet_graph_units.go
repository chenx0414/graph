package main

import "strings"

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
