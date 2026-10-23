package graph

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

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
	return HarnessProbeResult{
		GraphId:    graphId,
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
