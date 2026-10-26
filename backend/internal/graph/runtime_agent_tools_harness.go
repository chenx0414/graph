package graph

import (
	"strings"

	"errors"
)

// agentToolsHarnessHandlers are the handlers of the Harness tools.
func agentToolsHarnessHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"compare_harness_candidates": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessCompare == nil {
				panic(errors.New("Harness comparison is unavailable in this session"))
			}
			nodeIds := []string{}
			switch typed := params["nodeIds"].(type) {
			case []any:
				for _, item := range typed {
					nodeIds = append(nodeIds, agentToolsString(item))
				}
			case []string:
				nodeIds = append(nodeIds, typed...)
			}
			baseline := ""
			if value, ok := params["baselineNodeId"].(string); ok {
				baseline = strings.TrimSpace(value)
			}
			domain := ""
			if value, ok := params["domain"].(string); ok {
				domain = strings.TrimSpace(value)
			}
			comparison := input.GraphManagement.HarnessCompare(map[string]any{
				"graphId":        agentToolsString(params["graphId"]),
				"nodeIds":        nodeIds,
				"baselineNodeId": baseline,
				"domain":         domain,
			})
			return agentToolsText(stringifyJSON(comparison))
		},
		"record_harness_decision": func(id string, params map[string]any) any {
			requestId := ""
			if value, ok := params["requestId"].(string); ok {
				requestId = strings.TrimSpace(value)
			}
			harness := ""
			if value, ok := params["harness"].(string); ok {
				harness = strings.TrimSpace(value)
			}
			domain := strings.TrimSpace(agentToolsString(params["domain"]))
			axis := harnessAxis(agentToolsStringOrEmpty(params["axis"]))
			// The lessons already adopted in the scope this lesson lands in
			// are the ones it joins, so they are read before it is written.
			entries := []HarnessExperienceEntry{}
			if input.GraphManagement.HarnessExperience != nil {
				existing, ok := input.GraphManagement.HarnessExperience(map[string]any{
					"scope": harnessExperienceScope(domain, axis),
				}).(HarnessExperienceResult)
				if ok {
					entries = existing.Entries
				}
			}
			result := input.GraphManagement.HarnessDecision(&artifacts, entries, HarnessDecisionInput{
				GraphId:   strings.TrimSpace(agentToolsStringOrEmpty(params["graphId"])),
				Domain:    domain,
				Axis:      axis,
				Chosen:    strings.TrimSpace(agentToolsString(params["chosen"])),
				Cue:       strings.TrimSpace(agentToolsString(params["cue"])),
				Lesson:    strings.TrimSpace(agentToolsString(params["lesson"])),
				Evidence:  strings.TrimSpace(agentToolsString(params["evidence"])),
				Harness:   harness,
				RequestId: requestId,
			})
			return agentToolsText(stringifyJSON(result))
		},
		"read_harness_experience": func(id string, params map[string]any) any {
			domain := ""
			if value, ok := params["domain"].(string); ok {
				domain = strings.TrimSpace(value)
			}
			if input.GraphManagement.HarnessExperience == nil {
				return agentToolsText(stringifyJSON(HarnessExperienceResult{}))
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.HarnessExperience(map[string]any{"domain": domain})))
		},
		"read_harness_evidence": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessEvidence == nil {
				panic(errors.New("Reading harness evidence is unavailable in this session"))
			}
			limit := 0
			if value, ok := agentToolsNumber(params["limit"]); ok {
				limit = int(value)
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.HarnessEvidence(HarnessEvidenceInput{
				GraphId: agentToolsStringOrEmpty(params["graphId"]),
				NodeId:  agentToolsStringOrEmpty(params["nodeId"]),
				Kind:    agentToolsStringOrEmpty(params["kind"]),
				Limit:   limit,
			})))
		},
		"probe_harness": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessProbe == nil {
				panic(errors.New("Harness probing is unavailable in this session"))
			}
			variants, err := agentToolsHarnessVariants(params["variants"])
			if err != nil {
				panic(err)
			}
			timeout := 0
			if value, ok := agentToolsNumber(params["timeoutMs"]); ok {
				timeout = int(value)
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.HarnessProbe(HarnessProbeInput{
				Task:        agentToolsStringOrEmpty(params["task"]),
				Recipe:      agentToolsStringOrEmpty(params["recipe"]),
				Model:       agentToolsStringOrEmpty(params["model"]),
				BaseHarness: agentToolsStringOrEmpty(params["baseHarness"]),
				Variants:    variants,
				Domain:      agentToolsStringOrEmpty(params["domain"]),
				TimeoutMs:   timeout,
			})))
		},
		"record_harness_friction": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessFriction == nil {
				panic(errors.New("Recording harness friction is unavailable in this session"))
			}
			requestId := ""
			if value, ok := params["requestId"].(string); ok {
				requestId = strings.TrimSpace(value)
			}
			ref := ""
			if value, ok := params["ref"].(string); ok {
				ref = strings.TrimSpace(value)
			}
			domain := strings.TrimSpace(agentToolsStringOrEmpty(params["domain"]))
			axis := harnessAxis(agentToolsStringOrEmpty(params["axis"]))
			scope := harnessExperienceScope(domain, axis)
			entries := []HarnessExperienceEntry{}
			if input.GraphManagement.HarnessExperience != nil {
				existing, ok := input.GraphManagement.HarnessExperience(map[string]any{"scope": scope}).(HarnessExperienceResult)
				if ok {
					entries = existing.Entries
				}
			}
			result := input.GraphManagement.HarnessFriction(&artifacts, entries, HarnessFrictionInput{
				Domain:    domain,
				Axis:      axis,
				Cue:       strings.TrimSpace(agentToolsStringOrEmpty(params["cue"])),
				Why:       strings.TrimSpace(agentToolsStringOrEmpty(params["why"])),
				Status:    strings.TrimSpace(agentToolsStringOrEmpty(params["status"])),
				Ref:       ref,
				RequestId: requestId,
			})
			return agentToolsText(stringifyJSON(result))
		},
		"declare_harness_domain": func(id string, params map[string]any) any {
			if !artifacts.present || artifacts.publish == nil {
				panic(errors.New("Declaring the harness domain is unavailable in this session"))
			}
			domain := strings.TrimSpace(agentToolsStringOrEmpty(params["domain"]))
			if domain == "" {
				panic(errors.New("A domain is required: the lessons of that domain reach the tasks that follow"))
			}
			requestId := ""
			if value, ok := params["requestId"].(string); ok {
				requestId = strings.TrimSpace(value)
			}
			if requestId == "" {
				requestId = "harness-domain-" + harnessSlug(domain)
			}
			content := domain
			published := artifacts.publish(PublishArtifactInput{
				Namespace: HARNESS_EXPERIENCE_NAMESPACE,
				Name:      HARNESS_DOMAIN_ARTIFACT,
				Content:   &content,
				MediaType: "text/plain",
				Title:     "Harness domain: " + domain,
				Summary:   "The kind of work this project does: " + domain,
				RequestId: requestId,
				Metadata:  map[string]any{"domain": harnessSlug(domain)},
			})
			promoted := published
			if artifacts.promote != nil {
				if record, promoteErr := harnessPromote(&artifacts, published, requestId+"-promote"); promoteErr == nil {
					promoted = record
				}
			}
			return agentToolsText(stringifyJSON(map[string]any{
				"domain":     domain,
				"artifactId": promoted.ArtifactId,
				"version":    promoted.Version,
			}))
		},
	}
}
