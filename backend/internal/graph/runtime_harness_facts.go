package graph

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

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
