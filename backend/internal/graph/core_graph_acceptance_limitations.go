package graph

import (
	"strings"
)

// acceptanceLimitationActorUser is the only actor that may waive a human
// acceptance item. It is written by the door that speaks as the user - the
// HTTP waiver route - and never read from a payload: an Agent that could name
// itself the user could sign an acceptance the user never made.
const acceptanceLimitationActorUser = "user"

// acceptanceLimitationActorAgent is every other actor: graph_control is the
// door the Agent, and the console acting on the Agent's behalf, use.
const acceptanceLimitationActorAgent = "agent"

// GraphAcceptanceLimitation is one limitation a caller asks the kernel to
// record for one acceptance item.
type GraphAcceptanceLimitation struct {
	AcceptanceId string `json:"acceptanceId"`
	Reason       string `json:"reason"`
	Evidence     string `json:"evidence"`
}

// AcceptanceLimitation is why one acceptance item may stay unmet, and on whose
// word. It is what an item reads as when a decision replaced its missing
// evidence.
type AcceptanceLimitation struct {
	Reason    string  `json:"reason"`
	Evidence  string  `json:"evidence"`
	Actor     string  `json:"actor"`
	Commit    *string `json:"commit"`
	CreatedAt int64   `json:"createdAt"`
}

// GraphAcceptanceWaiveInput is one user-side waiver: the user's own wording of
// why one acceptance item may stay unmet, and where that decision is recorded.
type GraphAcceptanceWaiveInput struct {
	GraphId      string
	AcceptanceId string
	Reason       string
	Evidence     string
	RequestId    string
}

// GraphAcceptanceClosure is what recording limitations answers with: the phase
// the graph is in now, every limitation the closure rests on, and the acceptance
// report read back after the write.
type GraphAcceptanceClosure struct {
	GraphId     string                    `json:"graphId"`
	Phase       string                    `json:"phase"`
	Replayed    bool                      `json:"replayed"`
	Limitations []AcceptanceLimitationRow `json:"limitations"`
	Acceptance  GraphAcceptanceReport     `json:"acceptance"`
}

// graphAcceptanceLimitationsOf reads the limitations array of a control payload.
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

// graphAcceptanceLimitationsOfPayload is the same read for the payload map the
// console and the Agent tool both hand over.
func graphAcceptanceLimitationsOfPayload(payload map[string]any) []GraphAcceptanceLimitation {
	if payload == nil {
		return []GraphAcceptanceLimitation{}
	}
	return graphAcceptanceLimitationsOf(payload["limitations"])
}

// completeWithLimitations closes a blocked graph on recorded limitations.
func (service *graphManagementService) completeWithLimitations(graphId string, input GraphControlInput) any {
	return service.applyAcceptanceLimitations(acceptanceLimitationPlan{
		graphId: graphId, actor: acceptanceLimitationActorAgent, limitations: input.Limitations,
		complete: true, requestId: input.RequestID,
	})
}

// WaiveAcceptance records the user's own waiver of one acceptance item. It never
// completes the graph: the user decides what the user accepts, and the closure
// of the graph is a separate, explicit action that reads these records.
func (service *graphManagementService) WaiveAcceptance(input GraphAcceptanceWaiveInput) any {
	return service.applyAcceptanceLimitations(acceptanceLimitationPlan{
		graphId: input.GraphId, actor: acceptanceLimitationActorUser,
		limitations: []GraphAcceptanceLimitation{{AcceptanceId: input.AcceptanceId, Reason: input.Reason, Evidence: input.Evidence}},
		complete:    false, requestId: input.RequestId,
	})
}

// acceptanceLimitationPlan is one decision to record: who decided it, which
// items it covers, and whether the graph closes on it.
type acceptanceLimitationPlan struct {
	graphId     string
	actor       string
	limitations []GraphAcceptanceLimitation
	complete    bool
	requestId   string
}

// applyAcceptanceLimitations is the one implementation both doors use.
//
// The order of the checks is the order a caller can act on them: the graph has
// to be blocked at all, the decision has to say something, every unmet item has
// to be covered by the closure, the items that may not be waived are refused by
// name, and a Git delivery that does not match the current commit is refused
// last. Nothing is written before every check passed, so a refusal leaves no
// record behind.
func (service *graphManagementService) applyAcceptanceLimitations(plan acceptanceLimitationPlan) any {
	graph := service.runtime(plan.graphId)
	if replay, ok := graphAcceptanceClosureReplay(service, plan); ok {
		return replay
	}
	phase := "unknown"
	if state := graph.State(); state != nil {
		phase = string(state.Phase)
	}
	if phase != "blocked" {
		Raise("invalid_graph", "Graph "+plan.graphId+" is "+phase+"; only a blocked graph closes with recorded limitations")
	}
	if len(plan.limitations) == 0 {
		Raise("invalid_input", "complete_with_limitations requires at least one limitation {acceptanceId,reason,evidence}")
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
	covered := map[string]bool{}
	for _, limitation := range plan.limitations {
		covered[limitation.AcceptanceId] = true
	}
	// Coverage is the closure's rule, not one waiver's: a user waiving the one
	// item they are deciding about does not thereby decide about the others.
	if plan.complete {
		uncovered := []string{}
		for _, item := range report.Items {
			if item.Status == "passed" || item.Status == "waived" {
				continue
			}
			if covered[item.Id] {
				continue
			}
			uncovered = append(uncovered, item.Id)
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
	service.kernel.ModuleTransaction(func() any {
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
		if plan.complete {
			graph.setPhase("completed")
			var sha any
			if task.IntegrationSha != nil {
				sha = *task.IntegrationSha
			}
			// The wake and the event carry the same records the closure rests on,
			// so whoever reads why the graph finished reads the decisions too.
			WakeForTaskCompleted(service.kernel.Store, plan.graphId, map[string]any{
				"phase": "completed", "integrationSha": sha, "limitations": records,
			})
			service.kernel.Store.Event(plan.graphId, "graph.completed", map[string]any{
				"revision": graph.State().Revision, "limitations": records,
			})
		}
		return nil
	})
	return graphAcceptanceClosureResult(service, plan.graphId, false)
}

// graphAcceptanceClosureReplay answers a request that already recorded its
// limitations with the same closure, instead of recording a second copy of a
// decision somebody made once. It runs first: a replay after the graph finished
// is still the same request, and the graph is no longer blocked then.
func graphAcceptanceClosureReplay(service *graphManagementService, plan acceptanceLimitationPlan) (any, bool) {
	request := strings.TrimSpace(plan.requestId)
	if request == "" {
		return nil, false
	}
	if len(service.kernel.AcceptanceLimitationsOfRequest(plan.graphId, request)) == 0 {
		return nil, false
	}
	return graphAcceptanceClosureResult(service, plan.graphId, true), true
}

// graphAcceptanceClosureResult reads the closure back the way a caller sees it.
func graphAcceptanceClosureResult(service *graphManagementService, graphId string, replayed bool) GraphAcceptanceClosure {
	phase := "unknown"
	if state := service.runtime(graphId).State(); state != nil {
		phase = string(state.Phase)
	}
	return GraphAcceptanceClosure{
		GraphId: graphId, Phase: phase, Replayed: replayed,
		Limitations: service.kernel.AcceptanceLimitations(graphId),
		Acceptance:  GraphAcceptance(service.kernel, graphId, service.artifacts),
	}
}

// graphAcceptanceWaivedItems is the latest recorded limitation per item that was
// decided for this commit. A record written for another commit is history: it
// never waives evidence about a different version, and the item has to be
// decided again.
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

// graphAcceptanceDeliveryMatches reports whether the recorded Git delivery is the
// current integration commit. A graph without an integration branch has nothing
// to match.
func graphAcceptanceDeliveryMatches(task TaskRow, report GraphAcceptanceReport) bool {
	if task.IntegrationBranch == nil || *task.IntegrationBranch == "" {
		return true
	}
	if !graphAcceptanceShaEqual(task.TargetSha, report.Commit) {
		return false
	}
	return report.Delivery.Commit != nil && graphAcceptanceShaEqual(report.Delivery.Commit, report.Commit)
}

// graphAcceptanceClosable reports whether this graph can be closed with recorded
// limitations right now, by the Agent: nothing is still running, the Git delivery
// matches, and every item that is not passed is missing evidence the Agent may
// waive. A missing human acceptance keeps the answer false until the user waives
// it themselves.
func graphAcceptanceClosable(task TaskRow, report GraphAcceptanceReport) bool {
	if !report.Drained || task.Paused != 0 || !graphAcceptanceDeliveryMatches(task, report) {
		return false
	}
	for _, item := range report.Items {
		if item.Status == "passed" || item.Status == "waived" {
			continue
		}
		if item.Status != "missing" || item.Kind == "human" {
			return false
		}
	}
	return true
}
