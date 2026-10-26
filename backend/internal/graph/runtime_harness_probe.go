package graph

import (
	"sort"
	"strings"
	"time"

	"fmt"
)

const (
	// HARNESS_EXPERIENCE_NAMESPACE is where a domain's lessons live. It is the
	// same namespace the harness backlog uses, so both kinds of harness
	// knowledge stay visible in one place.
	HARNESS_EXPERIENCE_NAMESPACE = "plans"
	// HARNESS_EXPERIENCE_PREFIX marks the artifacts that hold the lessons. It
	// is also the query prefix, so it has to be a slug on its own.
	HARNESS_EXPERIENCE_PREFIX = "harness-experience"
	// HARNESS_EXPERIENCE_SCHEMA is the identity of the stored shape. The
	// second version made the friction and the lesson two stages of one
	// record; the first is still read.
	HARNESS_EXPERIENCE_SCHEMA = "graph.harness-experience@2"
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
	Task   string `json:"task"`
	Recipe string `json:"recipe,omitempty"`
	Model  string `json:"model,omitempty"`
	// BaseHarness is "adopted" to start every variant from the harness this
	// project already adopted, or "none" to start from the library as it is.
	// Starting from the adopted harness is what makes the rounds compound:
	// each one tests a change on top of the last winner instead of beside it.
	BaseHarness string                `json:"baseHarness,omitempty"`
	Variants    []HarnessProbeVariant `json:"variants"`
	Domain      string                `json:"domain,omitempty"`
	TimeoutMs   int                   `json:"timeoutMs,omitempty"`
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

// HARNESS_PROBE_QUIET_MS is how long a probe tolerates a run where nothing at
// all happened. Silence is measured in observable work (transcript entries,
// model calls), not in execution state: a candidate that reads, edits and
// answers for minutes stays in one execution state the whole time, so state
// alone calls a working experiment stuck.
const HARNESS_PROBE_QUIET_MS = 120_000

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
	base := map[string]string{}
	if strings.TrimSpace(input.BaseHarness) == "adopted" {
		base = service.harnessAdoptedOverlay(service.ownerTaskId, strings.TrimSpace(input.Domain))
	}
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
		overlay := map[string]string{}
		for key, text := range base {
			overlay[key] = text
		}
		for key, text := range variant.Harness {
			overlay[key] = text
		}
		if len(overlay) > 0 {
			node["harness"] = overlay
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
		// candidate that is going nowhere. When no candidate has produced
		// anything observable for a long while, the honest answer is what has
		// happened so far - a candidate that did not finish is a fact too.
		signature := service.harnessProbeProgress(graphId)
		if signature != progress {
			progress = signature
			quietSince = NowMillis()
		} else if NowMillis()-quietSince >= HARNESS_PROBE_QUIET_MS {
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
//
// The signature has to move on work, not only on state: a candidate inside one
// long turn keeps its execution in `running` and the queue at zero while it
// calls tools and gets answers. Reading state alone therefore reports a busy
// experiment as a stalled one, and the contrast is published from candidates
// that had not finished (measured: three real candidates abandoned at 30 s with
// 5-12 tool calls and nothing submitted).
func (service *graphManagementService) harnessProbeProgress(graphId string) string {
	parts := []string{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT node_id,state FROM kernel_executions WHERE task_id=? ORDER BY node_id", graphId) {
		parts = append(parts, kernelString(row["node_id"])+"="+kernelString(row["state"]))
	}
	queued := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", graphId)
	parts = append(parts, "queued="+itoa(int(kernelInt(queued["count"]))))
	// Written work: every tool call and every answer a candidate produces lands
	// here, so this count moves while it works even though its state does not.
	entries := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM node_entries WHERE task_id=?", graphId)
	parts = append(parts, "entries="+itoa(int(kernelInt(entries["count"]))))
	// Model calls, which also cover the turn that is still streaming.
	calls := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM kernel_provider_calls WHERE task_id=?", graphId)
	parts = append(parts, "calls="+itoa(int(kernelInt(calls["count"]))))
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
