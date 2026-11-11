package main

import (
	"encoding/json"
	"strings"
)

type nodeRow struct {
	id         string
	role       string
	kind       string
	status     string
	model      string
	definition string
}

type taskRow struct {
	id      string
	request string
	status  string
	phase   string
	nodes   []nodeRow
}

type tasksPayload struct {
	Tasks []struct {
		ID      string `json:"id"`
		Request string `json:"request"`
		Status  string `json:"status"`
		Phase   string `json:"phase"`
		Nodes   []struct {
			ID         string `json:"id"`
			Role       string `json:"role"`
			Kind       string `json:"kind"`
			Status     string `json:"status"`
			Model      string `json:"model"`
			Definition string `json:"definitionVersion"`
		} `json:"nodes"`
	} `json:"tasks"`
}

func parseGraphTasks(payload []byte) ([]taskRow, error) {
	var listed tasksPayload
	if err := json.Unmarshal(payload, &listed); err != nil {
		return nil, err
	}
	rows := make([]taskRow, 0, len(listed.Tasks))
	for _, task := range listed.Tasks {
		row := taskRow{id: task.ID, request: task.Request, status: task.Status, phase: task.Phase}
		for _, node := range task.Nodes {
			row.nodes = append(row.nodes, nodeRow{
				id:         node.ID,
				role:       node.Role,
				kind:       node.Kind,
				status:     node.Status,
				model:      node.Model,
				definition: node.Definition,
			})
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func firstLine(text string, limit int) string {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	if len([]rune(line)) > limit {
		runes := []rune(line)
		return string(runes[:limit]) + "…"
	}
	return line
}

func taskLabel(row taskRow) string {
	request := firstLine(row.request, 32)
	if request == "" {
		request = "（没有目标描述）"
	}
	return request + " · " + row.status + " · " + row.phase
}

func nodeLabel(row nodeRow) string {
	label := row.id + " · " + row.role + " · " + row.status
	if row.model != "" {
		label += " · " + row.model
	}
	return label
}
