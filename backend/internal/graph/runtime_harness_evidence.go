package graph

import (
	"strings"

	"encoding/json"
)

// HARNESS_EVIDENCE_MAX_STEPS bounds the trajectory one node contributes.
const HARNESS_EVIDENCE_MAX_STEPS = 60

// HARNESS_EVIDENCE_MAX_ERRORS bounds the failed tool calls one node lists.
const HARNESS_EVIDENCE_MAX_ERRORS = 12

// HARNESS_EVIDENCE_MAX_TEXT bounds one transcript entry.
const HARNESS_EVIDENCE_MAX_TEXT = 600

// HarnessEvidenceInput asks for the evidence of one run.
type HarnessEvidenceInput struct {
	// GraphId names the graph to read. Absent means the caller's own task.
	GraphId string
	// NodeId narrows the reading to one node.
	NodeId string
	// Kind is "summary" (the digest) or "trajectory" (the ordered steps).
	Kind string
	// Limit bounds the trajectory steps per node.
	Limit int
}

// HarnessEvidenceToolError is one tool that failed, with the reason.
type HarnessEvidenceToolError struct {
	Tool   string `json:"tool"`
	Count  int    `json:"count"`
	Reason string `json:"reason"`
}

// HarnessEvidenceStep is one entry of a transcript.
type HarnessEvidenceStep struct {
	Seq     int    `json:"seq"`
	Kind    string `json:"kind"`
	Role    string `json:"role"`
	Tool    string `json:"tool,omitempty"`
	IsError bool   `json:"isError,omitempty"`
	Text    string `json:"text,omitempty"`
}

// HarnessEvidenceNode is what one node did.
type HarnessEvidenceNode struct {
	NodeId       string                     `json:"nodeId"`
	Role         string                     `json:"role"`
	Status       string                     `json:"status"`
	Steps        int                        `json:"steps"`
	ToolCalls    int                        `json:"toolCalls"`
	ToolErrors   []HarnessEvidenceToolError `json:"toolErrors,omitempty"`
	FinalMessage string                     `json:"finalMessage,omitempty"`
	Trajectory   []HarnessEvidenceStep      `json:"trajectory,omitempty"`
}

// HarnessEvidenceProblem is one open internal problem.
type HarnessEvidenceProblem struct {
	Id     string `json:"id"`
	Kind   string `json:"kind"`
	NodeId string `json:"nodeId,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// HarnessEvidenceFailure is one node that could not finish.
type HarnessEvidenceFailure struct {
	NodeId string `json:"nodeId"`
	Reason string `json:"reason"`
}

// HarnessEvidenceCheck is one applied change and how its checks went.
type HarnessEvidenceCheck struct {
	Title    string   `json:"title"`
	Status   string   `json:"status"`
	Commands []string `json:"commands,omitempty"`
}

// HarnessEvidenceUsage is what a run cost.
type HarnessEvidenceUsage struct {
	Requests int     `json:"requests"`
	Input    int64   `json:"input"`
	Output   int64   `json:"output"`
	Cost     float64 `json:"cost,omitempty"`
}

// HarnessEvidenceResult is the evidence of one run.
type HarnessEvidenceResult struct {
	TaskId      string                   `json:"taskId"`
	Nodes       []HarnessEvidenceNode    `json:"nodes"`
	Problems    []HarnessEvidenceProblem `json:"problems"`
	FailedNodes []HarnessEvidenceFailure `json:"failedNodes"`
	Checks      []HarnessEvidenceCheck   `json:"checks"`
	Usage       HarnessEvidenceUsage     `json:"usage"`
	Truncated   bool                     `json:"truncated,omitempty"`
}

// HarnessEvidence reads the evidence of the caller's own run, or of one of its
// graphs.
func (service *graphManagementService) HarnessEvidence(input HarnessEvidenceInput) HarnessEvidenceResult {
	taskId := service.ownerTaskId
	if graphId := strings.TrimSpace(input.GraphId); graphId != "" {
		taskId = service.ownedGraph(graphId)
	}
	kind := strings.TrimSpace(input.Kind)
	if kind == "" {
		kind = "summary"
	}
	limit := input.Limit
	if limit <= 0 {
		limit = HARNESS_EVIDENCE_MAX_STEPS
	}
	if limit > 200 {
		limit = 200
	}
	result := HarnessEvidenceResult{TaskId: taskId, Nodes: []HarnessEvidenceNode{}}
	for _, node := range service.harnessEvidenceNodes(taskId, strings.TrimSpace(input.NodeId)) {
		evidence := service.harnessEvidenceNode(taskId, node.NodeId, node.Role, node.Status, kind, limit)
		result.Nodes = append(result.Nodes, evidence)
	}
	result.Problems = service.harnessEvidenceProblems(taskId)
	result.FailedNodes = service.harnessEvidenceFailures(taskId)
	result.Checks = service.harnessEvidenceChecks(taskId)
	result.Usage = service.harnessEvidenceUsage(taskId)
	return result
}

// ownedGraph resolves a graph the owner task may read, and refuses the rest.
func (service *graphManagementService) ownedGraph(graphId string) string {
	if graphId == service.ownerTaskId {
		return graphId
	}
	row := kernelRow(service.kernel.Db, "SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?", graphId)
	if row == nil {
		Raise("not_found", "Graph "+graphId+" is not one of yours")
	}
	if kernelString(row["owner_task_id"]) != service.ownerTaskId {
		Raise("not_found", "Graph "+graphId+" is not one of yours")
	}
	return graphId
}

// harnessEvidenceNodeView is one node of the run.
type harnessEvidenceNodeView struct {
	NodeId string
	Role   string
	Status string
}

// harnessEvidenceNodes lists the nodes of a run.
func (service *graphManagementService) harnessEvidenceNodes(taskId, nodeId string) []harnessEvidenceNodeView {
	views := []harnessEvidenceNodeView{}
	for _, node := range service.kernel.ListNodes(taskId) {
		views = append(views, harnessEvidenceNodeView{NodeId: node.NodeId, Role: service.harnessEvidenceRole(taskId, node.NodeId), Status: node.Status})
	}
	if len(views) == 0 {
		for _, row := range kernelRows(service.kernel.Db, "SELECT id,spec,status FROM nodes WHERE task_id=? ORDER BY id", taskId) {
			views = append(views, harnessEvidenceNodeView{
				NodeId: kernelString(row["id"]),
				Role:   harnessEvidenceSpecRole(kernelString(row["spec"])),
				Status: kernelString(row["status"]),
			})
		}
	}
	if nodeId == "" {
		return views
	}
	for _, view := range views {
		if view.NodeId == nodeId {
			return []harnessEvidenceNodeView{view}
		}
	}
	return nil
}

// harnessEvidenceRole is the role a node ran under. The node spec carries it.
func (service *graphManagementService) harnessEvidenceRole(taskId, nodeId string) string {
	row := kernelRow(service.kernel.Db, "SELECT spec FROM kernel_nodes WHERE task_id=? AND node_id=?", taskId, nodeId)
	if row == nil {
		row = kernelRow(service.kernel.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	}
	if row == nil {
		return ""
	}
	return harnessEvidenceSpecRole(kernelString(row["spec"]))
}

// harnessEvidenceSpecRole reads the role out of a node spec.
func harnessEvidenceSpecRole(spec string) string {
	record := map[string]any{}
	if err := json.Unmarshal([]byte(spec), &record); err != nil {
		return ""
	}
	role, _ := record["role"].(string)
	return role
}

// harnessEvidenceNode collects what one node did.
//
// Two record shapes carry a node's tool calls. A node that runs inside a graph
// writes transcript entries with the tool name, the result and the reason a
// call failed. The Agent of this conversation writes no transcript entries; its
// tool calls are in the event stream, with the tool name and the error flag.
// Both are read, so the reading does not depend on which kind of run it looks
// at.
func (service *graphManagementService) harnessEvidenceNode(taskId, nodeId, role, status, kind string, limit int) HarnessEvidenceNode {
	evidence := HarnessEvidenceNode{NodeId: nodeId, Role: role, Status: status}
	errors := map[string]*HarnessEvidenceToolError{}
	errorOrder := []string{}
	rows := kernelRows(service.kernel.Db, "SELECT seq,kind,role,text,data FROM node_entries WHERE task_id=? AND node_id=? ORDER BY seq", taskId, nodeId)
	for _, row := range rows {
		entryKind := kernelString(row["kind"])
		text := kernelString(row["text"])
		data := harnessEvidenceData(kernelString(row["data"]))
		tool, _ := data["toolName"].(string)
		isError, _ := data["isError"].(bool)
		if entryKind == "call" {
			evidence.ToolCalls++
		}
		if isError {
			reason, _ := data["message"].(string)
			if reason == "" {
				reason = text
			}
			harnessEvidenceAddError(errors, &errorOrder, tool, reason)
		}
		if entryKind == "message" && kernelString(row["role"]) == "assistant" && strings.TrimSpace(text) != "" {
			evidence.FinalMessage = harnessEvidenceBound(text, HARNESS_EVIDENCE_MAX_TEXT)
		}
		if kind == "trajectory" {
			evidence.Trajectory = append(evidence.Trajectory, HarnessEvidenceStep{
				Seq:     int(kernelInt(row["seq"])),
				Kind:    entryKind,
				Role:    kernelString(row["role"]),
				Tool:    tool,
				IsError: isError,
				Text:    harnessEvidenceBound(text, HARNESS_EVIDENCE_MAX_TEXT),
			})
		}
	}
	evidence.Steps = len(rows)
	if len(rows) == 0 {
		// No transcript: the tool events of this node's operations are what
		// the run left behind.
		for _, call := range service.harnessEvidenceToolCalls(taskId, nodeId) {
			evidence.ToolCalls++
			if call.IsError {
				harnessEvidenceAddError(errors, &errorOrder, call.Tool, call.Detail)
			}
			if kind == "trajectory" {
				evidence.Trajectory = append(evidence.Trajectory, HarnessEvidenceStep{
					Seq:     len(evidence.Trajectory) + 1,
					Kind:    "call",
					Role:    "tool",
					Tool:    call.Tool,
					IsError: call.IsError,
					Text:    harnessEvidenceBound(call.Detail, HARNESS_EVIDENCE_MAX_TEXT),
				})
			}
		}
		if evidence.Steps == 0 {
			evidence.Steps = evidence.ToolCalls
		}
	}
	for _, tool := range errorOrder {
		if len(evidence.ToolErrors) >= HARNESS_EVIDENCE_MAX_ERRORS {
			break
		}
		evidence.ToolErrors = append(evidence.ToolErrors, *errors[tool])
	}
	if len(evidence.Trajectory) > limit {
		evidence.Trajectory = evidence.Trajectory[:limit]
	}
	return evidence
}

// harnessEvidenceToolCall is one completed tool call of a node.
type harnessEvidenceToolCall struct {
	Tool    string
	Detail  string
	IsError bool
}

// harnessEvidenceToolCalls reads the tool calls of one node from the events.
func (service *graphManagementService) harnessEvidenceToolCalls(taskId, nodeId string) []harnessEvidenceToolCall {
	operations := []string{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT id FROM operations WHERE task_id=? AND node_id=?", taskId, nodeId) {
		operations = append(operations, kernelString(row["id"]))
	}
	for _, row := range kernelRows(service.kernel.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=?", taskId, nodeId) {
		operations = append(operations, kernelString(row["id"]))
	}
	if len(operations) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(operations)), ",")
	args := []any{taskId}
	for _, id := range operations {
		args = append(args, id)
	}
	calls := []harnessEvidenceToolCall{}
	rows := kernelRows(service.kernel.Db, `SELECT json_extract(data,'$.toolName') AS tool,
      json_extract(data,'$.isError') AS is_error, json_extract(data,'$.summary') AS summary
      FROM events WHERE task_id=? AND type='message.tool' AND json_extract(data,'$.phase')='end'
      AND json_extract(data,'$.operationId') IN (`+placeholders+`) ORDER BY rowid`, args...)
	for _, row := range rows {
		calls = append(calls, harnessEvidenceToolCall{
			Tool:    kernelString(row["tool"]),
			Detail:  kernelString(row["summary"]),
			IsError: kernelInt(row["is_error"]) != 0,
		})
	}
	return calls
}

// harnessEvidenceAddError records one failed tool call under its tool.
func harnessEvidenceAddError(errors map[string]*HarnessEvidenceToolError, order *[]string, tool, reason string) {
	entry, ok := errors[tool]
	if !ok {
		entry = &HarnessEvidenceToolError{Tool: tool}
		errors[tool] = entry
		*order = append(*order, tool)
	}
	entry.Count++
	if entry.Reason == "" {
		entry.Reason = harnessEvidenceBound(reason, HARNESS_EVIDENCE_MAX_TEXT)
	}
}

// harnessEvidenceData decodes the payload of one transcript entry.
func harnessEvidenceData(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	record := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return map[string]any{}
	}
	return record
}

// harnessEvidenceProblems lists the open internal problems of a run.
func (service *graphManagementService) harnessEvidenceProblems(taskId string) []HarnessEvidenceProblem {
	problems := []HarnessEvidenceProblem{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT id,node_id,kind,data FROM questions WHERE task_id=? AND status='open' AND owner='main' ORDER BY rowid", taskId) {
		problem := HarnessEvidenceProblem{
			Id:     kernelString(row["id"]),
			Kind:   kernelString(row["kind"]),
			NodeId: kernelString(row["node_id"]),
		}
		data := harnessEvidenceData(kernelString(row["data"]))
		for _, key := range []string{"reason", "message", "detail", "question"} {
			if value, ok := data[key].(string); ok && strings.TrimSpace(value) != "" {
				problem.Detail = harnessEvidenceBound(value, HARNESS_EVIDENCE_MAX_TEXT)
				break
			}
		}
		problems = append(problems, problem)
	}
	return problems
}

// harnessEvidenceFailures lists the nodes that could not finish.
func (service *graphManagementService) harnessEvidenceFailures(taskId string) []HarnessEvidenceFailure {
	failures := []HarnessEvidenceFailure{}
	seen := map[string]bool{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT node_id,reason FROM kernel_queue WHERE task_id=? AND state IN ('failed','blocked') ORDER BY rowid", taskId) {
		nodeId := kernelString(row["node_id"])
		reason := kernelString(row["reason"])
		if nodeId == "" || reason == "" || seen[nodeId] {
			continue
		}
		seen[nodeId] = true
		failures = append(failures, HarnessEvidenceFailure{NodeId: nodeId, Reason: harnessEvidenceBound(reason, HARNESS_EVIDENCE_MAX_TEXT)})
	}
	for _, row := range kernelRows(service.kernel.Db, "SELECT data FROM events WHERE task_id=? AND type='graph.node.failed' ORDER BY rowid", taskId) {
		data := harnessEvidenceData(kernelString(row["data"]))
		nodeId, _ := data["nodeId"].(string)
		reason, _ := data["reason"].(string)
		if nodeId == "" || seen[nodeId] {
			continue
		}
		seen[nodeId] = true
		failures = append(failures, HarnessEvidenceFailure{NodeId: nodeId, Reason: harnessEvidenceBound(reason, HARNESS_EVIDENCE_MAX_TEXT)})
	}
	return failures
}

// harnessEvidenceChecks lists the applied changes and how their checks went.
func (service *graphManagementService) harnessEvidenceChecks(taskId string) []HarnessEvidenceCheck {
	checks := []HarnessEvidenceCheck{}
	rows := kernelRows(service.kernel.Db, "SELECT data FROM events WHERE task_id=? AND type='rsi.change' ORDER BY rowid DESC LIMIT 10", taskId)
	for _, row := range rows {
		receipt := harnessEvidenceData(kernelString(row["data"]))
		if len(receipt) == 0 {
			continue
		}
		check := HarnessEvidenceCheck{
			Title:  kernelString(receipt["title"]),
			Status: kernelString(receipt["status"]),
		}
		if validation, ok := receipt["validation"].([]any); ok {
			for _, item := range validation {
				record, ok := item.(map[string]any)
				if !ok {
					continue
				}
				check.Commands = append(check.Commands, kernelString(record["command"]))
			}
		}
		checks = append(checks, check)
	}
	return checks
}

// harnessEvidenceUsage totals what a run cost.
func (service *graphManagementService) harnessEvidenceUsage(taskId string) HarnessEvidenceUsage {
	usage := HarnessEvidenceUsage{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT usage,cost FROM invocations WHERE operation_id IN (SELECT id FROM operations WHERE task_id=?)", taskId) {
		usage.Requests++
		recorded := TokenUsage{}
		if err := json.Unmarshal([]byte(kernelString(row["usage"])), &recorded); err == nil {
			usage.Input += recorded.Input
			usage.Output += recorded.Output
		}
		if cost := kernelString(row["cost"]); cost != "" {
			var value float64
			if err := json.Unmarshal([]byte(cost), &value); err == nil {
				usage.Cost += value
			}
		}
	}
	return usage
}

// harnessEvidenceBound keeps one piece of evidence short enough to travel.
func harnessEvidenceBound(text string, limit int) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) <= limit {
		return trimmed
	}
	return trimmed[:limit] + "..."
}
