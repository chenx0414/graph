package graph

import (
	"fmt"
	"sort"
	"strings"

	"encoding/json"
)

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
	// Harness is the prompt text this candidate ran under, when the node
	// replaced it. It says why two candidates behaved differently, which is
	// what a later composition of the two needs.
	Harness      map[string]string `json:"harness,omitempty"`
	InputTokens  int64             `json:"inputTokens"`
	OutputTokens int64             `json:"outputTokens"`
	ElapsedMs    int64             `json:"elapsedMs"`
	Messages     int               `json:"messages"`
	FinalMessage string            `json:"finalMessage,omitempty"`
}

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

func (service *graphManagementService) harnessCandidateFacts(graphId string, nodeIds []string) []HarnessCandidateFacts {
	executions := map[string]*HarnessCandidateFacts{}
	order := []string{}
	revision := service.kernel.LatestRevision(graphId)
	for _, nodeId := range nodeIds {
		facts := &HarnessCandidateFacts{NodeId: nodeId, Status: "not-run", Outputs: []string{}, Tools: []string{}}
		if revision != nil {
			if node, ok := revision.Definition.Nodes[nodeId]; ok && len(node.Harness) > 0 {
				facts.Harness = map[string]string{}
				for key, text := range node.Harness {
					facts.Harness[key] = text
				}
			}
		}
		executions[nodeId] = facts
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

func harnessToolName(text string) string {
	call := struct {
		Name string `json:"name"`
	}{}
	if err := json.Unmarshal([]byte(text), &call); err != nil {
		return ""
	}
	return call.Name
}

func harnessBoundText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}

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
