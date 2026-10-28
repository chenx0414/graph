package graph

import (
	"encoding/json"
	"strings"
	"sync"
)

type WorkConfirmInput struct {
	WorkRevision  int64   `json:"workRevision"`
	Version       int64   `json:"version"`
	DraftRevision int64   `json:"draftRevision"`
	GraphKey      string  `json:"graphKey"`
	TargetBranch  *string `json:"targetBranch"`
}

type graphConfirmLock struct {
	mu   sync.Mutex
	refs int
}

var graphConfirmLocks = struct {
	mu      sync.Mutex
	entries map[string]*graphConfirmLock
}{entries: map[string]*graphConfirmLock{}}

func lockWorkGraph(workID, key string) func() {
	identity := workID + "\x00" + key
	graphConfirmLocks.mu.Lock()
	entry := graphConfirmLocks.entries[identity]
	if entry == nil {
		entry = &graphConfirmLock{}
		graphConfirmLocks.entries[identity] = entry
	}
	entry.refs++
	graphConfirmLocks.mu.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		graphConfirmLocks.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(graphConfirmLocks.entries, identity)
		}
		graphConfirmLocks.mu.Unlock()
	}
}

func (runtime *TaskRuntime) ConfirmWorkGraph(workID string, input WorkConfirmInput, requestID string) WorkGraph {
	runtime.ensureOpen()
	input.GraphKey = strings.TrimSpace(input.GraphKey)
	if input.GraphKey == "" || len(input.GraphKey) > 100 {
		Raise("invalid_input", "graphKey must contain 1 to 100 bytes")
	}
	if input.TargetBranch != nil {
		branch := strings.TrimSpace(*input.TargetBranch)
		if branch == "" {
			input.TargetBranch = nil
		} else {
			input.TargetBranch = &branch
		}
	}
	unlock := lockWorkGraph(workID, input.GraphKey)
	defer unlock()
	result := runtime.store.Command("work:confirm:"+workID, requestID, input, func() any {
		existing := runtime.store.workGraphInTransaction(workID, input.GraphKey)
		if existing != nil {
			work := runtime.store.workInTransaction(workID)
			if work.ProjectID != nil {
				requireProjectActive(runtime.store, *work.ProjectID)
			}
			if existing.State != "ready" && (work.ExecutionPaused || work.ProjectID == nil || !runtime.allowedProjects()[*work.ProjectID]) {
				Raise("paused", "The work is paused or its project is unavailable")
			}
			if existing.WorkRevision != input.WorkRevision || existing.Version != input.Version || existing.DraftRevision != input.DraftRevision || CanonicalJSON(existing.TargetBranch) != CanonicalJSON(input.TargetBranch) {
				Raise("idempotency_conflict", "graphKey already names a different confirmed draft")
			}
			return *existing
		}
		work := runtime.store.workInTransaction(workID)
		if work.ProjectID == nil || !runtime.allowedProjects()[*work.ProjectID] {
			Raise("invalid_input", "Work needs a configured project")
		}
		requireProjectActive(runtime.store, *work.ProjectID)
		if work.Revision != input.WorkRevision || work.ExecutionPaused || (work.State != "clarifying" && work.State != "ready" && work.State != "dispatched") {
			Raise("stale_work", "Work changed, is paused, or cannot be confirmed")
		}
		draft := runtime.store.workDraftInTransaction(workID, input.Version, false)
		if draft.Stale || draft.Archived || draft.WorkRevision != input.WorkRevision || draft.DraftRevision != input.DraftRevision {
			Raise("stale_draft", "The selected draft changed or is unavailable")
		}
		owner := kernelRow(runtime.store.Db, "SELECT anchor_task_id FROM conversations WHERE role='project' AND project_id=? AND archived_at IS NULL", *work.ProjectID)
		if owner == nil {
			Raise("thread_selection_required", "Open the project supervisor before confirming work")
		}
		proposal := draft.Proposal
		if proposal["definition"] == nil {
			Raise("invalid_proposal", "The draft must contain a graph definition")
		}
		reservation := WorkGraph{WorkID: workID, GraphKey: input.GraphKey, WorkRevision: input.WorkRevision, Version: input.Version, DraftRevision: input.DraftRevision, TargetBranch: input.TargetBranch, State: "preparing", OwnerTaskID: kernelString(owner["anchor_task_id"]), KernelRequestID: graphUUID(), Proposal: proposal, ProposalDigest: draft.Digest}
		runtime.store.insertWorkGraph(reservation, NowMillis())
		runtime.store.Event(reservation.OwnerTaskID, "work.graph.confirmed", map[string]any{"workId": workID, "graphKey": input.GraphKey, "workRevision": input.WorkRevision, "version": input.Version, "draftRevision": input.DraftRevision, "actor": "user"})
		return reservation
	})
	reservation := workGraphReceipt(result)
	// Command replay contains the original reservation. Current state is read separately.
	runtime.store.txMu.Lock()
	current := runtime.store.workGraphInTransaction(workID, input.GraphKey)
	runtime.store.txMu.Unlock()
	if current == nil {
		Raise("not_found", "Work graph reservation not found")
	}
	reservation = *current
	if reservation.State == "ready" {
		return reservation
	}
	graphInput := map[string]any{"definition": reservation.Proposal["definition"], "requestId": reservation.KernelRequestID}
	if reservation.TargetBranch != nil {
		graphInput["targetBranch"] = *reservation.TargetBranch
	}
	created := runtime.graphManagement(reservation.OwnerTaskID).GraphCreate(graphInput)
	graphID, state := "", "ready"
	var reason *string
	switch value := created.(type) {
	case GraphCreateResult:
		graphID = value.GraphId
	case GraphCreateBlocked:
		graphID = value.GraphId
		state = "blocked"
		reason = &value.Reason
	default:
		Raise("invalid_graph", "Graph creation returned an invalid receipt")
	}
	runtime.store.Transaction(func() any {
		runtime.store.settleWorkGraph(workID, input.GraphKey, graphID, state, reason, NowMillis())
		runtime.store.Event(reservation.OwnerTaskID, "work.graph."+state, map[string]any{"workId": workID, "graphKey": input.GraphKey, "graphId": graphID})
		if state == "ready" {
			work := runtime.store.workInTransaction(workID)
			if !work.ExecutionPaused && work.ProjectID != nil && !projectArchived(runtime.store, *work.ProjectID) {
				runtime.resumeArchivePausedWorkGraphs(workID)
			}
			WakeMaster(runtime.store, WakeIntent{TaskID: graphID, Kind: "graph_ready", DedupeKey: graphID + ":ready", Data: map[string]any{"graphId": graphID, "workId": workID}, HasData: true})
		}
		return nil
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	runtime.store.txMu.Lock()
	current = runtime.store.workGraphInTransaction(workID, input.GraphKey)
	runtime.store.txMu.Unlock()
	return *current
}

func workGraphReceipt(value any) WorkGraph {
	if graph, ok := value.(WorkGraph); ok {
		return graph
	}
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var graph WorkGraph
	if err = json.Unmarshal(body, &graph); err != nil {
		panic(err)
	}
	return graph
}
