package graph

import (
	"strings"

	"encoding/json"
)

type DriverHost interface {
	Start() HostProcess
	Alive() bool
	Turn(text string) TurnReport
}

type NodeTurnDriverOptions struct {
	Kernel               *KernelStore
	GraphId              string
	NodeId               string
	Host                 DriverHost
	Submit               func(executionId string) *TurnInjection
	InitialContext       func() string
	TurnText             func(injection *TurnInjection) string
	MissingRequiredNames func(executionId string) []string
}

type NodeTurnDriver struct {
	options NodeTurnDriverOptions
}

func NewNodeTurnDriver(options NodeTurnDriverOptions) *NodeTurnDriver {
	return &NodeTurnDriver{options: options}
}

func (driver *NodeTurnDriver) Run(executionId string, attempt int, injection *TurnInjection, input *QueueRow) TurnReport {
	if !driver.options.Host.Alive() {
		driver.options.Host.Start()
	}

	prompt := driver.promptFor(executionId, attempt, injection, input)
	AppendNodeEntry(driver.options.Kernel.Store, NodeEntryInput{
		TaskID: driver.options.GraphId, NodeID: driver.options.NodeId, OperationID: executionId,
		Role: "user", Kind: "message", Text: prompt,
	})
	turn := driver.options.Host.Turn(prompt)
	var usage *TurnUsage
	if turn.Usage != nil {
		usage = &TurnUsage{Total: turn.Usage.Total, Accounted: turn.Usage.Accounted}
	}

	if turn.Error != nil {
		return TurnReport{Done: false, Error: turn.Error, Usage: usage}
	}
	if turn.Interrupted {
		return TurnReport{Interrupted: true, Usage: usage}
	}
	if driver.options.Kernel.HasRecordedNodeQuestion(executionId) {
		return TurnReport{QuestionPending: true, Usage: usage}
	}

	var gap *TurnInjection
	if driver.options.Submit != nil {
		gap = driver.options.Submit(executionId)
	}

	if driver.submissionExists(executionId) {
		return TurnReport{Done: true, Usage: usage}
	}

	if gap != nil && len(gap.Missing) > 0 {
		return TurnReport{Done: false, Missing: gap.Missing, Usage: usage}
	}

	if driver.missingRequired(executionId) {
		var names []string
		if driver.options.MissingRequiredNames != nil {
			names = driver.options.MissingRequiredNames(executionId)
		} else if execution := driver.options.Kernel.Execution(executionId); execution != nil {
			names = execution.PendingGap
		}
		if len(names) > 0 {
			return TurnReport{Done: false, Missing: names, Usage: usage}
		}
		return TurnReport{Done: false, Usage: usage}
	}
	if input != nil && input.Kind == "chat" {
		return TurnReport{Done: true, Usage: usage}
	}
	required := driver.requiredOutputs(executionId)
	if input != nil && len(required) > 0 {
		return TurnReport{Done: false, Missing: required, Usage: usage}
	}
	return TurnReport{Done: input != nil, Usage: usage}
}

func (driver *NodeTurnDriver) submissionExists(executionId string) bool {
	row := kernelRow(driver.options.Kernel.DB, "SELECT 1 FROM kernel_submissions WHERE execution_id=? LIMIT 1", executionId)
	return row != nil
}

func (driver *NodeTurnDriver) missingRequired(executionId string) bool {
	row := kernelRow(driver.options.Kernel.DB, "SELECT missing_required FROM kernel_executions WHERE id=?", executionId)
	return row != nil && kernelInt(row["missing_required"]) == 1
}

func (driver *NodeTurnDriver) requiredOutputs(executionId string) []string {
	execution := driver.options.Kernel.Execution(executionId)
	if execution == nil {
		return nil
	}
	revision := driver.options.Kernel.Revision(execution.TaskId, execution.RevisionVersion)
	if revision == nil {
		return nil
	}
	node, ok := revision.Definition.Nodes[execution.NodeId]
	if !ok {
		return nil
	}
	required := []string{}
	required = append(required, node.Submission.Required...)
	required = append(required, node.Submission.RequiredAnyOf...)
	return required
}

func (driver *NodeTurnDriver) promptFor(executionId string, attempt int, injection *TurnInjection, input *QueueRow) string {
	answers := kernelRows(driver.options.Kernel.Db, `SELECT q.id,q.answer FROM node_questions n JOIN questions q ON q.id=n.question_id
 WHERE n.execution_id=? AND n.state='answered' AND q.status='resolved' ORDER BY n.rowid`, executionId)
	if len(answers) > 0 && injection == nil {
		return "The project supervisor answered your question. Continue the same work and submit the required outputs. Recorded answers: " + CanonicalJSON(answers)
	}
	if injection != nil && len(injection.Missing) > 0 {
		parts := []string{
			"Your previous submission was refused: the required output(s) " + strings.Join(injection.Missing, ", ") + " were not enabled.",
			"Submit exactly this shape: {\"outputs\":{" + nodeTurnOutputShape(injection.Missing) + "}} — every required output must appear with enable:true.",
			"Do not redo or rewrite the implementation; whatever you already wrote stays in place.",
		}
		if driver.options.TurnText != nil {
			parts = append(parts, "", driver.options.TurnText(injection))
		}
		return strings.Join(parts, "\n")
	}
	if attempt == 1 {
		return driver.firstTurnPrompt(executionId, input)
	}
	parts := []string{"Your previous turn did not produce a valid submission. Continue the same work and submit this time."}
	if driver.options.TurnText != nil {
		parts = append(parts, "", driver.options.TurnText(nil))
	}
	return strings.Join(parts, "\n")
}

func (driver *NodeTurnDriver) firstTurnPrompt(executionId string, input *QueueRow) string {
	execution := driver.options.Kernel.Execution(executionId)
	if execution == nil {
		return ""
	}
	revision := driver.options.Kernel.Revision(execution.TaskId, execution.RevisionVersion)
	if revision == nil {
		return ""
	}
	definition := revision.Definition
	node, hasNode := definition.Nodes[driver.options.NodeId]
	prior := driver.priorExecutions(execution.TaskId, execution.NodeId, executionId)
	decisions := ""
	if prior == 0 {
		if digest := driver.options.Kernel.Store.Task(execution.TaskId).DecisionDigest; digest != nil {
			decisions = *digest
		}
	}
	previous, hasPrevious := driver.previousRevisionVersion(execution.TaskId, execution.NodeId, executionId)
	finalReview := []AcceptanceCriterion{}
	for _, item := range definition.Acceptance {
		if item.Kind == "review" && item.Node == driver.options.NodeId {
			finalReview = append(finalReview, item)
		}
	}
	reviewDelivery := ""
	if len(finalReview) > 0 {
		reviewDelivery = "FINAL REVIEW REQUIREMENTS: " + nodeTurnJSON(finalReview) +
			". Publish immutable application/json with schema graph.review@1 and {commit,passed,reason}." +
			" commit must identify the version actually reviewed (null for a non-code result); reason must explain the verdict." +
			" Publication is separate from submit. If DELIVERABLE declares graph.review@1, write that JSON file;" +
			" it is published automatically when execution finishes."
	}
	updated := ""
	if hasPrevious && previous != execution.RevisionVersion {
		parts := []string{"CURRENT NODE CONFIGURATION: " + nodeTurnNodeConfig(node, hasNode)}
		if reviewDelivery != "" {
			parts = append(parts, reviewDelivery)
		}
		updated = strings.Join(parts, "\n")
	}
	context := ""
	if driver.options.InitialContext != nil {
		context = driver.options.InitialContext()
	} else if prior == 0 && hasNode {
		context = driver.graphContext(definition, node, decisions, reviewDelivery)
	}
	instructions := ""
	if prior == 0 && node.Instructions != "" {
		instructions = "INSTRUCTIONS:\n" + node.Instructions
	}
	tail := ""
	if input != nil {
		tail = "NEW " + strings.ToUpper(input.Kind) + ": " + nodeTurnJSON(input.Payload)
	} else if driver.options.TurnText != nil {
		tail = driver.options.TurnText(nil)
	}
	parts := []string{}
	for _, part := range []string{context, instructions, updated, driver.verificationBriefing(execution.TaskId, definition), tail} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, "\n\n")
}

func (driver *NodeTurnDriver) priorExecutions(taskId, nodeId, executionId string) int {
	row := kernelRow(driver.options.Kernel.DB, "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND node_id=? AND id<>?",
		taskId, nodeId, executionId)
	return int(kernelInt(row["n"]))
}

func (driver *NodeTurnDriver) previousRevisionVersion(taskId, nodeId, executionId string) (int, bool) {
	row := kernelRow(driver.options.Kernel.DB, "SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND id<>? ORDER BY rowid DESC LIMIT 1",
		taskId, nodeId, executionId)
	if row == nil {
		return 0, false
	}
	return int(kernelInt(row["revision_version"])), true
}

type nodeTurnGraphCounts struct {
	Nodes   int `json:"nodes"`
	Modules int `json:"modules"`
	Edges   int `json:"edges"`
}

type nodeTurnPort struct {
	Protocol string `json:"protocol"`
	Version  *int   `json:"version,omitempty"`
}

type nodeTurnNodePreview struct {
	Recipe  string                  `json:"recipe"`
	Task    string                  `json:"task"`
	Inputs  map[string]nodeTurnPort `json:"inputs"`
	Outputs map[string]nodeTurnPort `json:"outputs"`
}

type nodeTurnOperationPreview struct {
	Action  string   `json:"action"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type nodeTurnModulePreview struct {
	Type      string                    `json:"type"`
	Inputs    map[string]nodeTurnPort   `json:"inputs"`
	Outputs   map[string]nodeTurnPort   `json:"outputs"`
	Operation *nodeTurnOperationPreview `json:"operation,omitempty"`
}

type nodeTurnGraphOverview struct {
	Counts  nodeTurnGraphCounts              `json:"counts"`
	Nodes   map[string]nodeTurnNodePreview   `json:"nodes"`
	Modules map[string]nodeTurnModulePreview `json:"modules"`
	Edges   map[string]EdgeDefinition        `json:"edges"`
	Inputs  map[string]GraphIo               `json:"inputs"`
	Outputs map[string]GraphOutput           `json:"outputs"`
}

func (driver *NodeTurnDriver) graphContext(definition GraphDefinition, node NodeDefinition, decisions, reviewDelivery string) string {
	lines := []string{
		"GRAPH OVERVIEW: " + definition.Name,
		nodeTurnJSON(driver.graphOverview(definition)),
		"GRAPH ACCEPTANCE: " + nodeTurnJSON(nodeTurnAcceptancePreview(definition.Acceptance)),
		"Overview previews at most 20 objects per section and 40 edges; long descriptions are abbreviated. Use read_graph for complete named objects or paged sections at this execution revision.",
		"TASK: " + node.Task,
	}
	if decisions != "" {
		lines = append(lines, "Decisions and constraints from the conversation:\n"+decisions)
	}
	lines = append(lines, "ACCEPTANCE: "+nodeTurnJSON(nodeTurnStringList(node.Acceptance)))
	if node.Deliverable != nil {
		lines = append(lines, "DELIVERABLE: "+nodeTurnJSON(node.Deliverable))
	}
	if reviewDelivery != "" {
		lines = append(lines, reviewDelivery)
	}
	lines = append(lines,
		"INPUT INTERFACES: "+nodeTurnJSON(nodeTurnProtocolRefs(node.Inputs)),
		"OUTPUT INTERFACES: "+nodeTurnJSON(nodeTurnProtocolRefs(node.Outputs)),
		"PROTOCOLS: "+nodeTurnJSON(nodeTurnOwnProtocols(definition, node)),
		"SUBMIT: "+nodeTurnJSON(node.Submission)+". At most one valid submit per execution. Chat may reply without submit.",
	)
	return strings.Join(lines, "\n")
}

func (driver *NodeTurnDriver) graphOverview(definition GraphDefinition) nodeTurnGraphOverview {
	overview := nodeTurnGraphOverview{
		Counts:  nodeTurnGraphCounts{Nodes: len(definition.Nodes), Modules: len(definition.Modules), Edges: len(definition.Edges)},
		Nodes:   map[string]nodeTurnNodePreview{},
		Modules: map[string]nodeTurnModulePreview{},
		Edges:   map[string]EdgeDefinition{},
		Inputs:  map[string]GraphIo{},
		Outputs: map[string]GraphOutput{},
	}
	for _, id := range sortedKeys(definition.Nodes) {
		if len(overview.Nodes) >= 20 {
			break
		}
		spec := definition.Nodes[id]
		overview.Nodes[id] = nodeTurnNodePreview{
			Recipe: spec.Recipe, Task: nodeTurnPreview(spec.Task),
			Inputs: nodeTurnInterfaces(spec.Inputs), Outputs: nodeTurnInterfaces(spec.Outputs),
		}
	}
	for _, id := range sortedKeys(definition.Modules) {
		if len(overview.Modules) >= 20 {
			break
		}
		spec := definition.Modules[id]
		preview := nodeTurnModulePreview{
			Type: spec.Type, Inputs: nodeTurnInterfaces(spec.Inputs), Outputs: nodeTurnInterfaces(spec.Outputs),
		}
		if spec.Type == "operation" && spec.Operation != nil {
			args := []string{}
			for index, arg := range spec.Operation.Args {
				if index >= 20 {
					break
				}
				args = append(args, nodeTurnPreview(arg))
			}
			preview.Operation = &nodeTurnOperationPreview{
				Action: spec.Operation.Action, Command: nodeTurnPreview(spec.Operation.Command), Args: args,
			}
		}
		overview.Modules[id] = preview
	}
	for _, id := range sortedKeys(definition.Edges) {
		if len(overview.Edges) >= 40 {
			break
		}
		overview.Edges[id] = definition.Edges[id]
	}
	for _, id := range sortedKeys(definition.Inputs) {
		if len(overview.Inputs) >= 20 {
			break
		}
		overview.Inputs[id] = definition.Inputs[id]
	}
	for _, id := range sortedKeys(definition.Outputs) {
		if len(overview.Outputs) >= 20 {
			break
		}
		overview.Outputs[id] = definition.Outputs[id]
	}
	return overview
}

func nodeTurnInterfaces(refs map[string]ProtocolRef) map[string]nodeTurnPort {
	out := map[string]nodeTurnPort{}
	for _, id := range sortedKeys(refs) {
		if len(out) >= 20 {
			break
		}
		out[id] = nodeTurnPort{Protocol: refs[id].Protocol, Version: refs[id].Version}
	}
	return out
}

func nodeTurnProtocolRefs(refs map[string]ProtocolRef) map[string]ProtocolRef {
	if refs == nil {
		return map[string]ProtocolRef{}
	}
	return refs
}

func nodeTurnOwnProtocols(definition GraphDefinition, node NodeDefinition) map[string]ProtocolSpec {
	own := map[string]bool{}
	for _, port := range node.Inputs {
		own[port.Protocol] = true
	}
	for _, port := range node.Outputs {
		own[port.Protocol] = true
	}
	out := map[string]ProtocolSpec{}
	for _, id := range sortedKeys(definition.Protocols) {
		if own[id] {
			out[id] = definition.Protocols[id]
		}
	}
	return out
}

func nodeTurnAcceptancePreview(acceptance []AcceptanceCriterion) []AcceptanceCriterion {
	out := []AcceptanceCriterion{}
	for index, item := range acceptance {
		if index >= 20 {
			break
		}
		item.Description = nodeTurnPreview(item.Description)
		out = append(out, item)
	}
	return out
}

func nodeTurnStringList(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nodeTurnNodeConfig(node NodeDefinition, hasNode bool) string {
	if !hasNode {
		return "undefined"
	}
	return nodeTurnJSON(node)
}

func nodeTurnPreview(value string) string {
	runes := []rune(value)
	if len(runes) > 240 {
		return string(runes[:240]) + "…"
	}
	return value
}

func nodeTurnJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(raw)
}
