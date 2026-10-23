package graph

import (
	"encoding/json"
	"strings"
)

// DriverHost is the part of the resident host a turn needs. Deliberately the
// same shape ExecutorHost requires, so one host value satisfies both and the
// executor can hand it straight to a driver.
type DriverHost interface {
	Start() HostProcess
	Alive() bool
	Turn(text string) TurnReport
}

// NodeTurnDriverOptions configures one node's turn driver.
type NodeTurnDriverOptions struct {
	Kernel  *KernelStore
	GraphId string
	NodeId  string
	Host    DriverHost
	Submit  func(executionId string) *TurnInjection
	// The full first-turn briefing (§7); omitted in tests that do not need it.
	InitialContext func() string
	// Work arriving with this turn — a delivery or a chat line (§7 first vs. follow-up).
	TurnText func(injection *TurnInjection) string
	// The durable gap names for an execution that was refused; used after a restart.
	MissingRequiredNames func(executionId string) []string
}

// NodeTurnDriver is the production turn runner NodeExecutor plugs into.
//
// NodeExecutor already knows WHAT to do with a turn's outcome — retry,
// resubmit, or move on — but it takes that outcome from a TurnRunner. This is
// the production runner: it starts a dead worker, builds the right prompt for
// this attempt, drives one turn, and then reads the KERNEL back to decide what
// actually happened. The kernel is the authority: a turn counts as done only
// when a submission for this execution really exists, never because the process
// said something reassuring.
//
// Prompts follow §7. The first turn of an execution carries the whole briefing;
// later turns are continuations that do not repeat it. A resubmit names the
// required output that is still missing and says the work already done stands,
// so the node corrects a field instead of redoing the implementation.
type NodeTurnDriver struct {
	options NodeTurnDriverOptions
}

// NewNodeTurnDriver creates one node's turn driver.
func NewNodeTurnDriver(options NodeTurnDriverOptions) *NodeTurnDriver {
	return &NodeTurnDriver{options: options}
}

// Run drives one turn for this execution. Called by NodeExecutor.runOne, which
// owns the attempt, retry and resubmit budgets.
func (driver *NodeTurnDriver) Run(executionId string, attempt int, injection *TurnInjection, input *QueueRow) TurnReport {
	// A crash rebuild keeps the same execution: rebuild before the turn, not instead of it.
	if !driver.options.Host.Alive() {
		driver.options.Host.Start()
	}

	prompt := driver.promptFor(executionId, attempt, injection, input)
	AppendNodeEntry(driver.options.Kernel.Store, NodeEntryInput{
		TaskID: driver.options.GraphId, NodeID: driver.options.NodeId, OperationID: executionId,
		Role: "user", Kind: "message", Text: prompt,
	})
	turn := driver.options.Host.Turn(prompt)
	// Kept for every exit below: a turn that costs something must be charged even when it
	// fails or is resubmitted, or the budget under-counts exactly the turns that misbehave.
	var usage *TurnUsage
	if turn.Usage != nil {
		usage = &TurnUsage{Total: turn.Usage.Total, Accounted: turn.Usage.Accounted}
	}

	// TODO(port): the TypeScript driver read the last assistant message's stopReason out
	// of turn.inspect; the ported ExecutorHost contract reports a failed turn as
	// TurnReport.Error instead, so that is the signal read here.
	if turn.Error != nil {
		return TurnReport{Done: false, Error: turn.Error, Usage: usage}
	}

	// The node's submit runs against the kernel; a refusal is reported, not swallowed.
	var gap *TurnInjection
	if driver.options.Submit != nil {
		gap = driver.options.Submit(executionId)
	}

	// The kernel decides: a real submission means done, whatever the process said.
	if driver.submissionExists(executionId) {
		return TurnReport{Done: true, Usage: usage}
	}

	if gap != nil && len(gap.Missing) > 0 {
		return TurnReport{Done: false, Missing: gap.Missing, Usage: usage}
	}

	// The execution's own missing-required mark is the durable record of a refusal: it
	// survives a process restart, so a crash mid-submit still resumes as a resubmit.
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
		return TurnReport{Done: turn.Answered, Usage: usage}
	}
	required := driver.requiredOutputs(executionId)
	if input != nil && len(required) > 0 {
		return TurnReport{Done: false, Missing: required, Usage: usage}
	}
	// A turn that produced no answer is not a finished turn. A node that
	// reports "done" for a turn that said nothing reports work that was never
	// done, and the graph moves on as if it had been.
	return TurnReport{Done: input != nil && turn.Answered, Usage: usage}
}

// submissionExists reports whether the kernel holds a submission for this execution.
func (driver *NodeTurnDriver) submissionExists(executionId string) bool {
	row := kernelRow(driver.options.Kernel.DB, "SELECT 1 FROM kernel_submissions WHERE execution_id=? LIMIT 1", executionId)
	return row != nil
}

// missingRequired reports the execution's own missing-required mark.
func (driver *NodeTurnDriver) missingRequired(executionId string) bool {
	row := kernelRow(driver.options.Kernel.DB, "SELECT missing_required FROM kernel_executions WHERE id=?", executionId)
	return row != nil && kernelInt(row["missing_required"]) == 1
}

// requiredOutputs are the outputs a submission of this execution must enable.
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

// promptFor is the prompt for this attempt: an injected gap, a continuation, or
// the full briefing.
func (driver *NodeTurnDriver) promptFor(executionId string, attempt int, injection *TurnInjection, input *QueueRow) string {
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
	// A later attempt is a continuation: it must not repeat the whole briefing (§7).
	parts := []string{"Your previous turn did not produce a valid submission. Continue the same work and submit this time."}
	if driver.options.TurnText != nil {
		parts = append(parts, "", driver.options.TurnText(nil))
	}
	return strings.Join(parts, "\n")
}

// nodeTurnOutputShape is the exact output shape a refused submission must use.
func nodeTurnOutputShape(missing []string) string {
	parts := make([]string, 0, len(missing))
	for _, name := range missing {
		parts = append(parts, `"`+name+`":{"enable":true,"value":<value>}`)
	}
	return strings.Join(parts, ",")
}

// firstTurnPrompt is the full first-turn briefing of one execution.
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
	for _, part := range []string{context, instructions, updated, tail} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, "\n\n")
}

// priorExecutions counts the other executions this node already ran.
func (driver *NodeTurnDriver) priorExecutions(taskId, nodeId, executionId string) int {
	row := kernelRow(driver.options.Kernel.DB, "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND node_id=? AND id<>?",
		taskId, nodeId, executionId)
	return int(kernelInt(row["n"]))
}

// previousRevisionVersion is the revision of the newest other execution of this node.
func (driver *NodeTurnDriver) previousRevisionVersion(taskId, nodeId, executionId string) (int, bool) {
	row := kernelRow(driver.options.Kernel.DB, "SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND id<>? ORDER BY rowid DESC LIMIT 1",
		taskId, nodeId, executionId)
	if row == nil {
		return 0, false
	}
	return int(kernelInt(row["revision_version"])), true
}

// nodeTurnGraphCounts is the size of a graph overview.
type nodeTurnGraphCounts struct {
	Nodes   int `json:"nodes"`
	Modules int `json:"modules"`
	Edges   int `json:"edges"`
}

// nodeTurnPort is one interface port of a node or module.
type nodeTurnPort struct {
	Protocol string `json:"protocol"`
	Version  *int   `json:"version,omitempty"`
}

// nodeTurnNodePreview is one node of a graph overview.
type nodeTurnNodePreview struct {
	Recipe  string                  `json:"recipe"`
	Task    string                  `json:"task"`
	Inputs  map[string]nodeTurnPort `json:"inputs"`
	Outputs map[string]nodeTurnPort `json:"outputs"`
}

// nodeTurnOperationPreview is one operation module of a graph overview.
type nodeTurnOperationPreview struct {
	Action  string   `json:"action"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

// nodeTurnModulePreview is one module of a graph overview.
type nodeTurnModulePreview struct {
	Type      string                    `json:"type"`
	Inputs    map[string]nodeTurnPort   `json:"inputs"`
	Outputs   map[string]nodeTurnPort   `json:"outputs"`
	Operation *nodeTurnOperationPreview `json:"operation,omitempty"`
}

// nodeTurnGraphOverview is the abbreviated graph a first turn receives.
type nodeTurnGraphOverview struct {
	Counts  nodeTurnGraphCounts              `json:"counts"`
	Nodes   map[string]nodeTurnNodePreview   `json:"nodes"`
	Modules map[string]nodeTurnModulePreview `json:"modules"`
	Edges   map[string]EdgeDefinition        `json:"edges"`
	Inputs  map[string]GraphIo               `json:"inputs"`
	Outputs map[string]GraphOutput           `json:"outputs"`
}

// graphContext is the briefing a first turn carries.
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

// graphOverview abbreviates the graph a first turn receives.
func (driver *NodeTurnDriver) graphOverview(definition GraphDefinition) nodeTurnGraphOverview {
	overview := nodeTurnGraphOverview{
		Counts:  nodeTurnGraphCounts{Nodes: len(definition.Nodes), Modules: len(definition.Modules), Edges: len(definition.Edges)},
		Nodes:   map[string]nodeTurnNodePreview{},
		Modules: map[string]nodeTurnModulePreview{},
		Edges:   map[string]EdgeDefinition{},
		Inputs:  map[string]GraphIo{},
		Outputs: map[string]GraphOutput{},
	}
	// TODO(port): TypeScript kept the definition's insertion order; Go maps sort by key.
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

// nodeTurnInterfaces abbreviates the ports of a node or module.
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

// nodeTurnProtocolRefs is the raw interface map of a node.
func nodeTurnProtocolRefs(refs map[string]ProtocolRef) map[string]ProtocolRef {
	if refs == nil {
		return map[string]ProtocolRef{}
	}
	return refs
}

// nodeTurnOwnProtocols are the graph protocols this node's own ports promise.
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

// nodeTurnAcceptancePreview abbreviates the graph acceptance list.
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

// nodeTurnStringList is an absent list as an empty array.
func nodeTurnStringList(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// nodeTurnNodeConfig is the node declaration a changed configuration reports.
func nodeTurnNodeConfig(node NodeDefinition, hasNode bool) string {
	if !hasNode {
		// JSON.stringify(undefined) rendered as the bare word in the template.
		return "undefined"
	}
	return nodeTurnJSON(node)
}

// nodeTurnPreview abbreviates a long description.
func nodeTurnPreview(value string) string {
	runes := []rune(value)
	if len(runes) > 240 {
		return string(runes[:240]) + "…"
	}
	return value
}

// nodeTurnJSON serializes one prompt fragment.
func nodeTurnJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(raw)
}
