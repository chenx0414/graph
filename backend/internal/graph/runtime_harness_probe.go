package graph

import (
	"sort"
	"strings"
	"time"

	"fmt"
)

const (
	HARNESS_EXPERIENCE_NAMESPACE   = "plans"
	HARNESS_EXPERIENCE_PREFIX      = "harness-experience"
	HARNESS_EXPERIENCE_SCHEMA      = "graph.harness-experience@2"
	HARNESS_MAX_CANDIDATES         = 12
	HARNESS_EXPERIENCE_MAX_ENTRIES = 200
	HARNESS_EXPERIENCE_MAX_BYTES   = 262144
	HARNESS_MAX_FINAL_MESSAGE      = 2000
	HARNESS_MAX_OUTPUT_VALUE       = 2000
)

type HarnessProbeVariant struct {
	Label   string            `json:"label"`
	Axis    string            `json:"axis,omitempty"`
	Recipe  string            `json:"recipe,omitempty"`
	Model   string            `json:"model,omitempty"`
	Harness map[string]string `json:"harness,omitempty"`
}

type HarnessProbeInput struct {
	Task        string                `json:"task"`
	Recipe      string                `json:"recipe,omitempty"`
	Model       string                `json:"model,omitempty"`
	BaseHarness string                `json:"baseHarness,omitempty"`
	Variants    []HarnessProbeVariant `json:"variants"`
	Domain      string                `json:"domain,omitempty"`
	TimeoutMs   int                   `json:"timeoutMs,omitempty"`
}

type HarnessProbeCandidate struct {
	Label  string `json:"label"`
	Axis   string `json:"axis"`
	NodeId string `json:"nodeId"`
	AnonId string `json:"anonId"`
}

type HarnessProbeResult struct {
	GraphId    string                  `json:"graphId"`
	GraphPhase string                  `json:"graphPhase"`
	Task       string                  `json:"task"`
	Candidates []HarnessProbeCandidate `json:"candidates"`
	Comparison HarnessComparison       `json:"comparison"`
	WaitedMs   int64                   `json:"waitedMs"`
	TimedOut   bool                    `json:"timedOut"`
}

const HARNESS_PROBE_MAX_VARIANTS = 6

const HARNESS_PROBE_QUIET_MS = 120_000

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
			"integrate":  false,
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

func (service *graphManagementService) harnessProbeProgress(graphId string) string {
	parts := []string{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT node_id,state FROM kernel_executions WHERE task_id=? ORDER BY node_id", graphId) {
		parts = append(parts, kernelString(row["node_id"])+"="+kernelString(row["state"]))
	}
	queued := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", graphId)
	parts = append(parts, "queued="+itoa(int(kernelInt(queued["count"]))))
	entries := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM node_entries WHERE task_id=?", graphId)
	parts = append(parts, "entries="+itoa(int(kernelInt(entries["count"]))))
	calls := kernelRow(service.kernel.Db, "SELECT COUNT(*) AS count FROM kernel_provider_calls WHERE task_id=?", graphId)
	parts = append(parts, "calls="+itoa(int(kernelInt(calls["count"]))))
	return strings.Join(parts, ",")
}

func harnessCloseProbeGraph(service *graphManagementService, graphId string) {
	defer func() { _ = recover() }()
	service.GraphControl(GraphControlInput{GraphId: graphId, Action: "complete"})
}

func harnessGraphPhase(service *graphManagementService, graphId string) string {
	row := kernelRow(service.kernel.Db, "SELECT phase FROM tasks WHERE id=?", graphId)
	if row == nil {
		return ""
	}
	return kernelString(row["phase"])
}

func harnessAxis(axis string) string {
	normalized := strings.ToLower(strings.TrimSpace(axis))
	if normalized == HARNESS_AXIS_GENERAL {
		return HARNESS_AXIS_GENERAL
	}
	return HARNESS_AXIS_SPECIFIC
}

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
