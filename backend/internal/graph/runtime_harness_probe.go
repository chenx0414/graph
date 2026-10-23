package graph

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	// HARNESS_EXPERIENCE_NAMESPACE is where a domain's lessons live. It is the
	// same namespace the harness backlog uses, so both kinds of harness
	// knowledge stay visible in one place.
	HARNESS_EXPERIENCE_NAMESPACE = "plans"
	// HARNESS_EXPERIENCE_PREFIX marks the artifacts that hold the lessons. It
	// is also the query prefix, so it has to be a slug on its own.
	HARNESS_EXPERIENCE_PREFIX = "harness-experience"
	// HARNESS_EXPERIENCE_SCHEMA is the identity of the stored shape.
	HARNESS_EXPERIENCE_SCHEMA = "graph.harness-experience@1"
	// HARNESS_MAX_CANDIDATES bounds one comparison. A contrast wider than this
	// stops being readable as a contrast.
	HARNESS_MAX_CANDIDATES = 12
	// HARNESS_EXPERIENCE_MAX_ENTRIES bounds one domain's store.
	HARNESS_EXPERIENCE_MAX_ENTRIES = 200
	// HARNESS_EXPERIENCE_MAX_BYTES is how much of a stored lesson set is read.
	HARNESS_EXPERIENCE_MAX_BYTES = 262144
	// HARNESS_MAX_FINAL_MESSAGE bounds the answer a candidate ended with.
	HARNESS_MAX_FINAL_MESSAGE = 2000
	// HARNESS_MAX_OUTPUT_VALUE bounds one submitted output value.
	HARNESS_MAX_OUTPUT_VALUE = 2000
)

// The harness probe compares the candidates of one task and reports what each
// of them did differently. It reports facts, never a verdict: choosing between
// candidates stays with the Agent, because this kind of task has no ground
// truth to appeal to.

// HarnessCandidateFacts is what one candidate run did.

type HarnessCandidateFacts struct {
	AnonId       string            `json:"anonId"`
	NodeId       string            `json:"nodeId"`
	Status       string            `json:"status"`
	Submitted    bool              `json:"submitted"`
	Outputs      []string          `json:"outputs"`
	OutputValues map[string]string `json:"outputValues,omitempty"`
	ToolCalls    int               `json:"toolCalls"`
	ToolErrors   int               `json:"toolErrors"`
	Tools        []string          `json:"tools"`
	InputTokens  int64             `json:"inputTokens"`
	OutputTokens int64             `json:"outputTokens"`
	ElapsedMs    int64             `json:"elapsedMs"`
	Messages     int               `json:"messages"`
	FinalMessage string            `json:"finalMessage,omitempty"`
}

// HarnessDifference is one behavioral difference between a candidate and the
// baseline it was compared against.

type HarnessDifference struct {
	Field     string `json:"field"`
	Baseline  string `json:"baseline"`
	Candidate string `json:"candidate"`
}

type HarnessComparison struct {
	GraphId string `json:"graphId"`
	Domain  string `json:"domain,omitempty"`
	// Baseline is the anonymous id of the candidate the others are compared
	// against; BaselineNodeId names the node it is.
	Baseline     string                         `json:"baseline"`
	BaselineNode string                         `json:"baselineNodeId"`
	Candidates   []HarnessCandidateFacts        `json:"candidates"`
	Differences  map[string][]HarnessDifference `json:"differences"`
	Experience   []HarnessExperienceEntry       `json:"experience"`
}

// HarnessCompareInput asks for the contrast of some candidates of one graph.
type HarnessCompareInput struct {
	GraphId        string
	NodeIds        []string
	BaselineNodeId string
	Domain         string
}

// HarnessProbeVariant is one candidate harness of a probe: the same task, a
// different set of prompt texts.
//
// Axis says how far the variant's lesson would reach. A general variant tries
// a change that should hold for every kind of work; a specific variant tries
// one that holds for this domain only.
type HarnessProbeVariant struct {
	Label   string            `json:"label"`
	Axis    string            `json:"axis,omitempty"`
	Recipe  string            `json:"recipe,omitempty"`
	Model   string            `json:"model,omitempty"`
	Harness map[string]string `json:"harness,omitempty"`
}

// HarnessProbeInput asks the host to run one task under several harnesses.
type HarnessProbeInput struct {
	Task      string                `json:"task"`
	Recipe    string                `json:"recipe,omitempty"`
	Model     string                `json:"model,omitempty"`
	Variants  []HarnessProbeVariant `json:"variants"`
	Domain    string                `json:"domain,omitempty"`
	TimeoutMs int                   `json:"timeoutMs,omitempty"`
}

// HarnessProbeCandidate names one variant of a probe and the node that ran it.
type HarnessProbeCandidate struct {
	Label  string `json:"label"`
	Axis   string `json:"axis"`
	NodeId string `json:"nodeId"`
	AnonId string `json:"anonId"`
}

// HarnessProbeResult is the contrast a probe produced.
type HarnessProbeResult struct {
	GraphId string `json:"graphId"`
	// GraphPhase is where the probe's own graph ended up. A probe is an
	// experiment, not a deliverable, so it closes itself.
	GraphPhase string                  `json:"graphPhase"`
	Task       string                  `json:"task"`
	Candidates []HarnessProbeCandidate `json:"candidates"`
	Comparison HarnessComparison       `json:"comparison"`
	WaitedMs   int64                   `json:"waitedMs"`
	TimedOut   bool                    `json:"timedOut"`
}

// HARNESS_PROBE_MAX_VARIANTS bounds one probe. A contrast wider than this
// stops being readable as a contrast.
const HARNESS_PROBE_MAX_VARIANTS = 6

// HarnessProbe runs one task under several harnesses and contrasts them.
//
// The host builds the probe graph itself: the variants differ only in the
// prompt texts they run under, so the harness is the only variable left. The
// probe waits for every candidate to settle and then reports the same contrast
// compare_harness_candidates reports, so one comparison has one shape.
func (service *graphManagementService) HarnessProbe(input HarnessProbeInput) HarnessProbeResult {
	task := strings.TrimSpace(input.Task)
	if task == "" {
		Raise("invalid_input", "A probe needs a task for every candidate to answer")
	}
	if len(input.Variants) < 2 {
		Raise("invalid_input", "A probe needs at least two variants to compare")
	}
	if len(input.Variants) > HARNESS_PROBE_MAX_VARIANTS {
		Raise("invalid_input", fmt.Sprintf("A probe takes at most %d variants", HARNESS_PROBE_MAX_VARIANTS))
	}
	recipe := strings.TrimSpace(input.Recipe)
	nodes := map[string]any{}
	labels := map[string]bool{}
	nodeIds := []string{}
	for _, variant := range input.Variants {
		label := strings.TrimSpace(variant.Label)
		if label == "" {
			Raise("invalid_input", "Every probe variant needs a label")
		}
		if labels[label] {
			Raise("invalid_input", "Probe variant labels must be distinct: "+label)
		}
		labels[label] = true
		nodeId := harnessSlug(label)
		if nodeId == "unknown" {
			Raise("invalid_input", "Probe variant label must carry a name: "+label)
		}
		variantRecipe := strings.TrimSpace(variant.Recipe)
		if variantRecipe == "" {
			variantRecipe = recipe
		}
		if variantRecipe == "" {
			Raise("invalid_input", "Every probe variant needs a recipe; read_system_capabilities lists the agent definitions")
		}
		node := map[string]any{
			"recipe":     variantRecipe,
			"task":       task,
			"inputs":     map[string]any{"in": map[string]any{"protocol": "job"}},
			"outputs":    map[string]any{"out": map[string]any{"protocol": "done"}},
			"submission": map[string]any{"required": []any{"out"}},
		}
		model := strings.TrimSpace(variant.Model)
		if model == "" {
			model = strings.TrimSpace(input.Model)
		}
		if model != "" {
			node["model"] = model
		}
		if len(variant.Harness) > 0 {
			node["harness"] = variant.Harness
		}
		nodes[nodeId] = node
		nodeIds = append(nodeIds, nodeId)
	}
	definition := map[string]any{
		"schemaVersion": float64(INTERFACE_SCHEMA_VERSION),
		"name":          "Harness probe",
		"protocols": map[string]any{
			"job":  map[string]any{"type": "object"},
			"done": map[string]any{"type": "object"},
		},
		"nodes":   nodes,
		"modules": map[string]any{},
		"edges":   map[string]any{},
		"inputs":  map[string]any{},
		"outputs": map[string]any{},
	}
	// The definition is parsed, not trusted: an invalid harness key has to be
	// refused before a single token is spent.
	parsed := ParseGraphDefinition(definition)
	created := service.GraphCreate(GraphCreateInput{Definition: parsed})
	record := asMap(created)
	graphId := ""
	if record != nil {
		graphId, _ = record["graphId"].(string)
	}
	if graphId == "" {
		Raise("invalid_graph", "The probe graph could not be created")
	}
	for _, nodeId := range nodeIds {
		node := nodeId
		input := "in"
		service.GraphSend(GraphSendInput{GraphId: graphId, NodeId: &node, Input: &input, Value: map[string]any{"task": task}})
	}
	timeout := int64(input.TimeoutMs)
	if timeout <= 0 {
		timeout = 180_000
	}
	if timeout > 900_000 {
		timeout = 900_000
	}
	started := NowMillis()
	timedOut := false
	progress := ""
	quietSince := started
	for {
		if service.harnessProbeSettled(graphId) {
			break
		}
		elapsed := NowMillis() - started
		if elapsed >= timeout {
			timedOut = true
			break
		}
		// The probe holds the Agent's turn, so it must not wait for a
		// candidate that is going nowhere. When nothing about the candidates
		// has changed for a while, the honest answer is what has happened so
		// far - a candidate that did not finish is a fact too.
		signature := service.harnessProbeProgress(graphId)
		if signature != progress {
			progress = signature
			quietSince = NowMillis()
		} else if NowMillis()-quietSince >= 30_000 {
			timedOut = true
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	comparison := service.HarnessCompare(HarnessCompareInput{
		GraphId:        graphId,
		NodeIds:        nodeIds,
		BaselineNodeId: nodeIds[0],
		Domain:         strings.TrimSpace(input.Domain),
	})
	anonByNode := map[string]string{}
	for _, candidate := range comparison.Candidates {
		anonByNode[candidate.NodeId] = candidate.AnonId
	}
	candidates := []HarnessProbeCandidate{}
	for index, variant := range input.Variants {
		nodeId := nodeIds[index]
		candidates = append(candidates, HarnessProbeCandidate{
			Label:  strings.TrimSpace(variant.Label),
			Axis:   harnessAxis(variant.Axis),
			NodeId: nodeId,
			AnonId: anonByNode[nodeId],
		})
	}
	harnessCloseProbeGraph(service, graphId)
	return HarnessProbeResult{
		GraphId:    graphId,
		GraphPhase: harnessGraphPhase(service, graphId),
		Task:       task,
		Candidates: candidates,
		Comparison: comparison,
		WaitedMs:   NowMillis() - started,
		TimedOut:   timedOut,
	}
}

// harnessProbeProgress is a short description of what the candidates are doing.
// It changes while they work and stops changing when they are stuck.
func (service *graphManagementService) harnessProbeProgress(graphId string) string {
	parts := []string{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT node_id,state FROM kernel_executions WHERE task_id=? ORDER BY node_id", graphId) {
		parts = append(parts, kernelString(row["node_id"])+"="+kernelString(row["state"]))
	}
	queued := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", graphId)
	parts = append(parts, "queued="+itoa(int(kernelInt(queued["count"]))))
	return strings.Join(parts, ",")
}

// harnessCloseProbeGraph closes the graph the probe built. The candidates have
// settled, so the experiment is over; leaving the graph running would keep a
// project entry that never ends.
func harnessCloseProbeGraph(service *graphManagementService, graphId string) {
	defer func() { _ = recover() }()
	service.GraphControl(GraphControlInput{GraphId: graphId, Action: "complete"})
}

// harnessGraphPhase is where a graph stands.
func harnessGraphPhase(service *graphManagementService, graphId string) string {
	row := kernelRow(service.kernel.Db, "SELECT phase FROM tasks WHERE id=?", graphId)
	if row == nil {
		return ""
	}
	return kernelString(row["phase"])
}

// harnessAxis is the axis of a claim: general or specific. A claim that does
// not say stays specific, because a lesson only earns every domain's
// attention when it is claimed for every domain.
func harnessAxis(axis string) string {
	normalized := strings.ToLower(strings.TrimSpace(axis))
	if normalized == HARNESS_AXIS_GENERAL {
		return HARNESS_AXIS_GENERAL
	}
	return HARNESS_AXIS_SPECIFIC
}

// harnessProbeSettled reports whether every candidate has stopped working.
func (service *graphManagementService) harnessProbeSettled(graphId string) bool {
	for _, node := range service.kernel.ListNodes(graphId) {
		switch node.Status {
		case "pending", "preparing", "running":
			return false
		}
	}
	queued := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", graphId)
	return kernelInt(queued["count"]) == 0
}

func harnessAnonID(index int) string {
	out := ""
	n := index + 1
	for n > 0 {
		rem := (n - 1) % 26
		out = string(rune('A'+rem)) + out
		n = (n - 1) / 26
	}
	return out
}

// harnessCandidateNames normalizes the requested candidate list: no blanks, no
// duplicates, and a stable order so the anonymous ids do not shuffle between
// two reads of the same comparison.
func harnessCandidateNames(nodeIds []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, nodeId := range nodeIds {
		trimmed := strings.TrimSpace(nodeId)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	sort.Strings(out)
	return out
}

// HarnessCompare reads the behavioral facts of the candidates and the contrast
// between them. It reads only committed facts: an execution's state, what it
// submitted, which tools it called and what it cost.

func (service *graphManagementService) HarnessCompare(input HarnessCompareInput) HarnessComparison {
	graphId := strings.TrimSpace(input.GraphId)
	if graphId == "" {
		Raise("invalid_input", "A graph id is required")
	}
	revision := service.kernel.LatestRevision(graphId)
	if revision == nil {
		Raise("not_found", "Graph "+graphId+" has no revision")
	}
	candidates := harnessCandidateNames(input.NodeIds)
	if len(candidates) < 2 {
		Raise("invalid_input", "A comparison needs at least two candidate nodes")
	}
	if len(candidates) > HARNESS_MAX_CANDIDATES {
		Raise("invalid_input", fmt.Sprintf("A comparison takes at most %d candidates", HARNESS_MAX_CANDIDATES))
	}
	for _, nodeId := range candidates {
		if _, ok := revision.Definition.Nodes[nodeId]; !ok {
			Raise("invalid_input", "Graph "+graphId+" has no node "+nodeId)
		}
	}
	baseline := strings.TrimSpace(input.BaselineNodeId)
	if baseline == "" {
		baseline = candidates[0]
	}
	found := false
	for _, nodeId := range candidates {
		if nodeId == baseline {
			found = true
			break
		}
	}
	if !found {
		Raise("invalid_input", "The baseline node "+baseline+" is not one of the compared candidates")
	}

	facts := service.harnessCandidateFacts(graphId, candidates)
	byNode := map[string]HarnessCandidateFacts{}
	for _, candidate := range facts {
		byNode[candidate.NodeId] = candidate
	}
	comparison := HarnessComparison{
		GraphId:      graphId,
		Domain:       strings.TrimSpace(input.Domain),
		BaselineNode: baseline,
		Candidates:   facts,
		Differences:  map[string][]HarnessDifference{},
	}
	baseFacts, ok := byNode[baseline]
	if !ok {
		return comparison
	}
	comparison.Baseline = baseFacts.AnonId
	for _, candidate := range facts {
		if candidate.NodeId == baseline {
			continue
		}
		comparison.Differences[candidate.AnonId] = harnessDifferences(baseFacts, candidate)
	}
	if comparison.Domain != "" {
		// The lessons travel with the comparison: a new candidate is judged
		// against what earlier tasks learned. The domain's own lessons come
		// first, then the general ones - a general lesson holds for every
		// kind of work, so it reaches this domain too.
		comparison.Experience = append(
			harnessExperienceEntries(service.artifacts, service.ownerTaskId, harnessSlug(comparison.Domain)),
			harnessExperienceEntries(service.artifacts, service.ownerTaskId, HARNESS_GENERAL_SCOPE)...,
		)
	}
	return comparison
}

// HarnessExperienceInput reads the lessons of one domain.

func (service *graphManagementService) harnessCandidateFacts(graphId string, nodeIds []string) []HarnessCandidateFacts {
	executions := map[string]*HarnessCandidateFacts{}
	order := []string{}
	for _, nodeId := range nodeIds {
		executions[nodeId] = &HarnessCandidateFacts{NodeId: nodeId, Status: "not-run", Outputs: []string{}, Tools: []string{}}
		order = append(order, nodeId)
	}
	rows := kernelRows(service.kernel.Db, "SELECT node_id,state,started_at,ended_at FROM kernel_executions WHERE task_id=? ORDER BY rowid", graphId)
	for _, row := range rows {
		nodeId := kernelString(row["node_id"])
		facts, ok := executions[nodeId]
		if !ok {
			continue
		}
		facts.Status = kernelString(row["state"])
		started := kernelInt(row["started_at"])
		ended := kernelInt(row["ended_at"])
		if ended > started {
			facts.ElapsedMs = ended - started
		}
	}
	submissions := kernelRows(service.kernel.Db, `SELECT e.node_id AS node_id, s.outputs AS outputs
      FROM kernel_submissions s JOIN kernel_executions e ON e.id = s.execution_id
      WHERE s.task_id=? ORDER BY s.rowid`, graphId)
	for _, row := range submissions {
		facts, ok := executions[kernelString(row["node_id"])]
		if !ok {
			continue
		}
		facts.Submitted = true
		outputs, _ := service.kernel.Content.Decode(kernelString(row["outputs"])).(map[string]any)
		names := []string{}
		values := map[string]string{}
		for name, value := range outputs {
			names = append(names, name)
			values[name] = harnessBoundText(stringifyJSON(value), HARNESS_MAX_OUTPUT_VALUE)
		}
		sort.Strings(names)
		facts.Outputs = names
		facts.OutputValues = values
	}
	// The tool calls of a candidate are read from its transcript entries: a node
	// that runs in the durable kernel records its calls there, with the tool name
	// and the result, and the statistics table only holds the calls of the
	// session that owns the instance.
	tools := map[string]map[string]bool{}
	calls := map[string]int{}
	errors := map[string]int{}
	messages := map[string]int{}
	finals := map[string]string{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT node_id,kind,role,text FROM node_entries WHERE task_id=? ORDER BY node_id, seq", graphId) {
		nodeId := kernelString(row["node_id"])
		if _, ok := executions[nodeId]; !ok {
			continue
		}
		kind := kernelString(row["kind"])
		text := kernelString(row["text"])
		if kind == "call" {
			calls[nodeId]++
			name := harnessToolName(text)
			if name == "" {
				continue
			}
			if tools[nodeId] == nil {
				tools[nodeId] = map[string]bool{}
			}
			tools[nodeId][name] = true
			continue
		}
		if kind == "result" {
			if strings.Contains(text, "\"isError\":true") || strings.Contains(text, "\"is_error\":true") {
				errors[nodeId]++
			}
			continue
		}
		if kind == "message" && kernelString(row["role"]) == "assistant" {
			messages[nodeId]++
			if len(text) > 0 {
				finals[nodeId] = text
			}
		}
	}
	usageRows := kernelRows(service.kernel.Db, "SELECT node_id,usage FROM kernel_provider_calls WHERE task_id=? AND usage IS NOT NULL ORDER BY rowid", graphId)
	for _, row := range usageRows {
		facts, ok := executions[kernelString(row["node_id"])]
		if !ok {
			continue
		}
		usage := TokenUsage{}
		if err := json.Unmarshal([]byte(kernelString(row["usage"])), &usage); err != nil {
			continue
		}
		facts.InputTokens += usage.Input
		facts.OutputTokens += usage.Output
	}
	out := make([]HarnessCandidateFacts, 0, len(order))
	for index, nodeId := range order {
		facts := executions[nodeId]
		facts.AnonId = harnessAnonID(index)
		facts.ToolCalls = calls[nodeId]
		facts.ToolErrors = errors[nodeId]
		facts.Messages = messages[nodeId]
		facts.FinalMessage = harnessBoundText(finals[nodeId], HARNESS_MAX_FINAL_MESSAGE)
		names := []string{}
		for tool := range tools[nodeId] {
			names = append(names, tool)
		}
		sort.Strings(names)
		facts.Tools = names
		out = append(out, *facts)
	}
	return out
}

// harnessToolName reads the tool name of one transcript call entry.

func harnessToolName(text string) string {
	call := struct {
		Name string `json:"name"`
	}{}
	if err := json.Unmarshal([]byte(text), &call); err != nil {
		return ""
	}
	return call.Name
}

// harnessBoundText keeps a text short enough to travel in a report.

func harnessBoundText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}

// harnessOutputValues is the one-line form of the values a candidate
// submitted, so two candidates can be compared without reading both.

func harnessOutputValues(facts HarnessCandidateFacts) string {
	if len(facts.OutputValues) == 0 {
		return ""
	}
	names := []string{}
	for name := range facts.OutputValues {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := []string{}
	for _, name := range names {
		parts = append(parts, name+"="+facts.OutputValues[name])
	}
	return strings.Join(parts, " ")
}

// harnessDifferences reports the fields on which a candidate differs from the
// baseline. A field that matches is not a difference.

func harnessDifferences(base, candidate HarnessCandidateFacts) []HarnessDifference {
	differences := []HarnessDifference{}
	add := func(field, baseline, value string) {
		if baseline != value {
			differences = append(differences, HarnessDifference{Field: field, Baseline: baseline, Candidate: value})
		}
	}
	add("status", base.Status, candidate.Status)
	add("submitted", fmt.Sprintf("%t", base.Submitted), fmt.Sprintf("%t", candidate.Submitted))
	add("outputs", strings.Join(base.Outputs, ","), strings.Join(candidate.Outputs, ","))
	add("toolCalls", fmt.Sprintf("%d", base.ToolCalls), fmt.Sprintf("%d", candidate.ToolCalls))
	add("toolErrors", fmt.Sprintf("%d", base.ToolErrors), fmt.Sprintf("%d", candidate.ToolErrors))
	add("tools", strings.Join(base.Tools, ","), strings.Join(candidate.Tools, ","))
	add("outputValues", harnessOutputValues(base), harnessOutputValues(candidate))
	add("messages", fmt.Sprintf("%d", base.Messages), fmt.Sprintf("%d", candidate.Messages))
	add("finalMessage", base.FinalMessage, candidate.FinalMessage)
	add("inputTokens", fmt.Sprintf("%d", base.InputTokens), fmt.Sprintf("%d", candidate.InputTokens))
	add("outputTokens", fmt.Sprintf("%d", base.OutputTokens), fmt.Sprintf("%d", candidate.OutputTokens))
	add("elapsedMs", fmt.Sprintf("%d", base.ElapsedMs), fmt.Sprintf("%d", candidate.ElapsedMs))
	return differences
}

// harnessExperienceName is the artifact name one domain's lessons live under.
