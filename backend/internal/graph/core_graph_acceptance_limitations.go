package graph

import (
	"strings"
)

const acceptanceLimitationActorUser = "user"

const acceptanceLimitationActorAgent = "agent"

type GraphAcceptanceLimitation struct {
	AcceptanceId string `json:"acceptanceId"`
	Reason       string `json:"reason"`
	Evidence     string `json:"evidence"`
}

type AcceptanceLimitation struct {
	Reason    string  `json:"reason"`
	Evidence  string  `json:"evidence"`
	Actor     string  `json:"actor"`
	Commit    *string `json:"commit"`
	CreatedAt int64   `json:"createdAt"`
}

type GraphAcceptanceWaiveInput struct {
	GraphId      string
	AcceptanceId string
	Reason       string
	Evidence     string
	RequestId    string
}

type GraphAcceptanceClosure struct {
	GraphId     string                    `json:"graphId"`
	Phase       string                    `json:"phase"`
	Replayed    bool                      `json:"replayed"`
	Records     int                       `json:"records"`
	Limitations []AcceptanceLimitationRow `json:"limitations"`
	Acceptance  GraphAcceptanceReport     `json:"acceptance"`
}

func graphAcceptanceLimitationsOf(raw any) []GraphAcceptanceLimitation {
	switch typed := raw.(type) {
	case []GraphAcceptanceLimitation:
		return typed
	case []any:
		out := make([]GraphAcceptanceLimitation, 0, len(typed))
		for _, item := range typed {
			record, ok := item.(map[string]any)
			if !ok {
				continue
			}
			out = append(out, GraphAcceptanceLimitation{
				AcceptanceId: graphAcceptanceText(record["acceptanceId"]),
				Reason:       graphAcceptanceText(record["reason"]),
				Evidence:     graphAcceptanceText(record["evidence"]),
			})
		}
		return out
	}
	return []GraphAcceptanceLimitation{}
}

func graphAcceptanceText(value any) string {
	text, _ := value.(string)
	return text
}

func graphAcceptanceLimitationsOfPayload(payload map[string]any) []GraphAcceptanceLimitation {
	if payload == nil {
		return []GraphAcceptanceLimitation{}
	}
	return graphAcceptanceLimitationsOf(payload["limitations"])
}

func (service *graphManagementService) completeWithLimitations(graphId string, input GraphControlInput) any {
	return service.applyAcceptanceLimitations(acceptanceLimitationPlan{
		graphId: graphId, actor: acceptanceLimitationActorAgent, limitations: input.Limitations,
		complete: true, requestId: input.RequestID,
	})
}

func (service *graphManagementService) WaiveAcceptance(input GraphAcceptanceWaiveInput) any {
	return service.applyAcceptanceLimitations(acceptanceLimitationPlan{
		graphId: input.GraphId, actor: acceptanceLimitationActorUser,
		limitations: []GraphAcceptanceLimitation{{AcceptanceId: input.AcceptanceId, Reason: input.Reason, Evidence: input.Evidence}},
		complete:    false, requestId: input.RequestId,
	})
}

type acceptanceLimitationPlan struct {
	graphId     string
	actor       string
	limitations []GraphAcceptanceLimitation
	complete    bool
	requestId   string
}

func (service *graphManagementService) applyAcceptanceLimitations(plan acceptanceLimitationPlan) any {
	graph := service.runtime(plan.graphId)
	if replay, ok := graphAcceptanceClosureReplay(service, plan); ok {
		return replay
	}
	phase := GraphPhase("unknown")
	if state := graph.State(); state != nil {
		phase = state.Phase
	}
	if phase != PhaseBlocked {
		if plan.complete && len(plan.limitations) == 0 && phase == PhaseCompleted {
			return graphAcceptanceClosureResult(service, plan.graphId, false, 0)
		}
		Raise("invalid_graph", "Graph "+plan.graphId+" is "+string(phase)+"; only a blocked graph closes with recorded limitations")
	}
	for _, limitation := range plan.limitations {
		if strings.TrimSpace(limitation.AcceptanceId) == "" {
			Raise("invalid_input", "Every limitation must name the acceptanceId it covers")
		}
		if strings.TrimSpace(limitation.Reason) == "" {
			Raise("invalid_input", "Acceptance "+limitation.AcceptanceId+" needs a reason: why this evidence cannot be missing")
		}
		if strings.TrimSpace(limitation.Evidence) == "" {
			Raise("invalid_input", "Acceptance "+limitation.AcceptanceId+" needs evidence: where that reason is recorded")
		}
	}
	report := GraphAcceptance(service.kernel, plan.graphId, service.artifacts)
	unmet := []string{}
	for _, item := range report.Items {
		if item.Status == "passed" || item.Status == "waived" {
			continue
		}
		unmet = append(unmet, item.Id)
	}
	covered := map[string]bool{}
	for _, limitation := range plan.limitations {
		covered[limitation.AcceptanceId] = true
	}
	if len(plan.limitations) == 0 {
		if !plan.complete {
			Raise("invalid_input", "A waiver must name the acceptance item it covers")
		}
		if len(unmet) > 0 {
			Raise("invalid_input", "complete_with_limitations requires one limitation {acceptanceId,reason,evidence} for each unmet item: "+strings.Join(unmet, ", "))
		}
	}
	if plan.complete {
		uncovered := []string{}
		for _, id := range unmet {
			if covered[id] {
				continue
			}
			uncovered = append(uncovered, id)
		}
		if len(uncovered) > 0 {
			Raise("invalid_graph", "These acceptance items are unmet and no limitation covers them: "+strings.Join(uncovered, ", "))
		}
	}
	declared := map[string]AcceptanceStatus{}
	for _, item := range report.Items {
		declared[item.Id] = item
	}
	for _, limitation := range plan.limitations {
		item, ok := declared[limitation.AcceptanceId]
		if !ok {
			Raise("invalid_input", "Acceptance "+limitation.AcceptanceId+" is not declared by this graph")
		}
		if item.Verification != nil {
			Raise("invalid_graph", "Acceptance "+item.Id+" requires both verification receipts")
		}
		switch item.Status {
		case "failed":
			Raise("invalid_graph", "Acceptance "+item.Id+" failed and cannot be waived: the evidence exists and says no, so fix the work instead")
		case "stale":
			Raise("invalid_graph", "Acceptance "+item.Id+" is stale: its evidence concerns another commit, so it is re-proved, never waived")
		case "passed":
			Raise("invalid_input", "Acceptance "+item.Id+" passed and needs no limitation")
		}
		if item.Kind == "human" && plan.actor != acceptanceLimitationActorUser {
			Raise("permission", "Acceptance "+item.Id+" is a human acceptance; only the user can waive it, not the Agent")
		}
	}
	task := service.kernel.Store.Task(plan.graphId)
	if !graphAcceptanceDeliveryMatches(task, report) {
		Raise("invalid_graph", "The Git delivery of "+plan.graphId+" does not match its current integration commit; a delivery mismatch cannot be waived")
	}
	service.kernel.ModuleTransaction(func(kernel *KernelStore) any {
		commit := report.Commit
		revision := 0
		if latest := service.kernel.LatestRevision(plan.graphId); latest != nil {
			revision = latest.Version
		}
		entries := make([]AcceptanceLimitationEntry, 0, len(plan.limitations))
		request := strings.TrimSpace(plan.requestId)
		for _, limitation := range plan.limitations {
			entries = append(entries, AcceptanceLimitationEntry{
				AcceptanceId: limitation.AcceptanceId, Reason: strings.TrimSpace(limitation.Reason),
				Evidence: strings.TrimSpace(limitation.Evidence), Actor: plan.actor,
				Commit: commit, RevisionVersion: revision, RequestId: &request,
			})
		}
		records := service.kernel.RecordAcceptanceLimitations(plan.graphId, entries)
		for _, limitation := range plan.limitations {
			answered := service.kernel.Store.ResolveOpenHumanChecks(plan.graphId, limitation.AcceptanceId, map[string]any{
				"type": "waived", "actor": plan.actor, "reason": strings.TrimSpace(limitation.Reason),
				"evidence": strings.TrimSpace(limitation.Evidence), "commitSha": commit,
			})
			if len(answered) == 0 {
				continue
			}
			var commitValue any
			if commit != nil {
				commitValue = *commit
			}
			service.kernel.Store.Event(plan.graphId, "graph.acceptance.waived", map[string]any{
				"acceptanceId": limitation.AcceptanceId, "questionIds": answered, "actor": plan.actor, "commit": commitValue,
			})
		}
		if plan.complete {
			graph.setPhase("completed")
			var sha any
			if task.IntegrationSha != nil {
				sha = *task.IntegrationSha
			}
			WakeForTaskCompleted(service.kernel.Store, plan.graphId, map[string]any{
				"phase": "completed", "integrationSha": sha, "limitations": records,
			})
			service.kernel.Store.Event(plan.graphId, "graph.completed", map[string]any{
				"revision": graph.State().Revision, "limitations": records,
			})
		}
		return nil
	})
	return graphAcceptanceClosureResult(service, plan.graphId, false, len(plan.limitations))
}

func graphAcceptanceClosureReplay(service *graphManagementService, plan acceptanceLimitationPlan) (any, bool) {
	request := strings.TrimSpace(plan.requestId)
	if request == "" {
		return nil, false
	}
	if len(service.kernel.AcceptanceLimitationsOfRequest(plan.graphId, request)) == 0 {
		return nil, false
	}
	return graphAcceptanceClosureResult(service, plan.graphId, true, 0), true
}

func graphAcceptanceClosureResult(service *graphManagementService, graphId string, replayed bool, records int) GraphAcceptanceClosure {
	phase := "unknown"
	if state := service.runtime(graphId).State(); state != nil {
		phase = string(state.Phase)
	}
	return GraphAcceptanceClosure{
		GraphId: graphId, Phase: phase, Replayed: replayed, Records: records,
		Limitations: service.kernel.AcceptanceLimitations(graphId),
		Acceptance:  GraphAcceptance(service.kernel, graphId, service.artifacts),
	}
}

func graphAcceptanceWaivedItems(records []AcceptanceLimitationRow, commit *string) map[string]AcceptanceLimitationRow {
	out := map[string]AcceptanceLimitationRow{}
	for _, record := range records {
		if !graphAcceptanceShaEqual(record.Commit, commit) {
			continue
		}
		out[record.AcceptanceId] = record
	}
	return out
}

func graphAcceptanceDeliveryMatches(task TaskRow, report GraphAcceptanceReport) bool {
	if task.IntegrationBranch == nil || *task.IntegrationBranch == "" {
		return true
	}
	if !graphAcceptanceShaEqual(task.TargetSha, report.Commit) && !graphAcceptanceShaEqual(task.IntegrationSha, report.Commit) {
		return false
	}
	if report.Delivery.Commit == nil {
		return true
	}
	return graphAcceptanceShaEqual(report.Delivery.Commit, report.Commit)
}

func graphAcceptanceClosable(task TaskRow, report GraphAcceptanceReport) bool {
	if !report.Drained || task.Paused != 0 || !graphAcceptanceDeliveryMatches(task, report) {
		return false
	}
	for _, item := range report.Items {
		if item.Status == "passed" || item.Status == "waived" {
			continue
		}
		if item.Status != "missing" || item.Kind == "human" || item.Verification != nil {
			return false
		}
	}
	return true
}
