package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

const nodeLineLimit = 40

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

type nodeEntry struct {
	kind string
	role string
	text string
	tool string
}

type nodeRun struct {
	action  string
	model   string
	entries []nodeEntry
}

type nodeRunPayload struct {
	Node struct {
		Action string `json:"action"`
		Model  string `json:"model"`
	} `json:"node"`
	Entries []struct {
		Kind string `json:"kind"`
		Role string `json:"role"`
		Text string `json:"text"`
		Data *struct {
			ToolName string `json:"toolName"`
		} `json:"data"`
	} `json:"entries"`
}

func parseNodeRun(payload []byte) (nodeRun, error) {
	var shaped nodeRunPayload
	if err := json.Unmarshal(payload, &shaped); err != nil {
		return nodeRun{}, err
	}
	run := nodeRun{action: shaped.Node.Action, model: shaped.Node.Model}
	for _, entry := range shaped.Entries {
		line := nodeEntry{kind: entry.Kind, role: entry.Role, text: entry.Text}
		if entry.Data != nil {
			line.tool = entry.Data.ToolName
		}
		run.entries = append(run.entries, line)
	}
	return run, nil
}

func nodeEntryLine(entry nodeEntry) string {
	if entry.kind == "call" {
		name := entry.tool
		if name == "" {
			name = "调用"
		}
		return "→ " + name + " · " + firstLine(entry.text, 100)
	}
	author := "agent"
	if entry.role == "user" {
		author = "你"
	}
	return author + " · " + firstLine(entry.text, 160)
}

func (c *chatState) sendNodeMessage() {
	text := strings.TrimSpace(c.nodeDraft)
	if text == "" || c.nodeTaskID == "" || c.nodeID == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{
		"text":      text,
		"requestId": "native-node-" + strconv.FormatInt(time.Now().UnixNano(), 36),
	})
	request, err := daemonPostRequest(c.address, c.token, "/api/tasks/"+c.nodeTaskID+"/nodes/"+c.nodeID+"/messages", body)
	if err != nil {
		c.status = "发送失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "发送失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "发送被拒绝：" + response.Status
		c.frame()
		return
	}
	c.nodeDraft = ""
	c.status = "已发给节点，等它回话…"
	c.showNode(c.nodeTaskID, nodeRow{id: c.nodeID, role: c.nodeRole})
}

func (c *chatState) showNode(taskID string, node nodeRow) {
	payload, err := daemonGet(c.address, c.token, "/api/tasks/"+taskID+"/nodes/"+node.id+"/run")
	if err != nil {
		c.status = "读不到节点：" + err.Error()
		c.frame()
		return
	}
	run, err := parseNodeRun(payload)
	if err != nil {
		c.status = "节点记录不是预期的 JSON：" + err.Error()
		c.frame()
		return
	}
	lines := make([]string, 0, len(run.entries))
	for _, entry := range run.entries {
		lines = append(lines, nodeEntryLine(entry))
	}
	c.nodeTaskID = taskID
	c.nodeID = node.id
	c.nodeRole = node.role
	c.nodeTitle = node.id + " · " + node.role + " · " + strconv.Itoa(len(run.entries)) + " 条记录"
	if len(lines) > nodeLineLimit {
		lines = lines[len(lines)-nodeLineLimit:]
	}
	c.nodeLines = lines
	c.status = ""
	c.frame()
}

func (c *chatState) graphSection(ctx *ui.Context) {
	t := ctx.Theme()
	if len(c.tasks) > 0 && ui.Button(ctx, "图 · "+strconv.Itoa(len(c.tasks))+" 个任务").Clicked() {
		c.graphOpen = !c.graphOpen
	}
	if c.graphOpen {
		for _, task := range c.tasks {
			ui.Text(ctx, taskLabel(task)).FontSize(12)
			for _, node := range task.nodes {
				taskID := task.id
				row := node
				if ui.Button(ctx, nodeLabel(row)).Clicked() {
					go c.showNode(taskID, row)
				}
			}
		}
	}
	if len(c.nodeLines) > 0 {
		ui.Text(ctx, "节点记录 · "+c.nodeTitle).FontSize(12).TextColor(t.TextMuted)
		for _, line := range c.nodeLines {
			ui.Text(ctx, line).FontSize(12)
		}
		ui.Row(ctx).Gap(8).AlignItems(ui.End).Children(func() {
			ui.TextInput(ctx, &c.nodeDraft).Placeholder("给这个节点发消息…").Label("节点消息").Grow(1)
			if ui.PrimaryButton(ctx, "发给节点").Clicked() {
				go c.sendNodeMessage()
			}
		})
	}
}
