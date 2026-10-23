package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// GraphPhase is one of the eight lifecycle phases.
type GraphPhase string

// GraphStateRow is the lifecycle row the main agent reads.
type GraphStateRow struct {
	GraphId  string     `json:"graphId"`
	Phase    GraphPhase `json:"phase"`
	Revision int        `json:"revision"`
}

// PatchChange is one revision's reason plus a full definition or a merge patch.
type PatchChange struct {
	Reason     string
	Definition *GraphDefinition
	Patch      any
	Retire     []string
	HasPatch   bool
}

// CreatedGraph is the graph create returns.
type CreatedGraph struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   struct {
		Version int `json:"version"`
	} `json:"revision"`
}

// GraphRuntime owns graph lifecycle and the main agent's control surface.
type GraphRuntime struct {
	kernel    *KernelStore
	graphId   string
	artifacts *ArtifactWorkspace
}

// NewGraphRuntime binds one graph id to the shared kernel.
func NewGraphRuntime(kernel *KernelStore, graphId string, artifacts *ArtifactWorkspace) *GraphRuntime {
	return &GraphRuntime{kernel: kernel, graphId: graphId, artifacts: artifacts}
}

func (runtime *GraphRuntime) taskRow() map[string]any {
	return kernelRow(runtime.kernel.DB, "SELECT id FROM tasks WHERE id=?", runtime.graphId)
}

func (runtime *GraphRuntime) ensureTask() {
	if runtime.taskRow() == nil {
		Raise("invalid_graph", "Graph "+runtime.graphId+" does not exist; call create first")
	}
}

// Create validates the whole definition and produces the first revision.
func (runtime *GraphRuntime) Create(definition any, request, projectId string) CreatedGraph {
	parsed := ParseGraphDefinition(definition)
	if projectId == "" {
		projectId = "p1"
	}
	if request == "" {
		request = parsed.Name
	}
	created := runtime.kernel.Store.Transaction(func() any {
		if runtime.taskRow() != nil {
			Raise("invalid_graph", "Graph "+runtime.graphId+" already exists")
		}
		runtime.kernel.Store.CreateGraphTask(runtime.graphId, projectId, request, NowMillis())
		revision := runtime.kernel.InsertRevision(runtime.graphId, parsed, "create")
		result := CreatedGraph{GraphId: runtime.graphId, Definition: parsed}
		result.Revision.Version = revision.Version
		return result
	}).(CreatedGraph)
	return created
}

// Patch publishes a new revision. A stale base changes nothing.
func (runtime *GraphRuntime) Patch(baseRevision int, changes PatchChange) struct{ Revision int } {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == "completed" || phase == "stopping" || phase == "stopped" {
		Raise("invalid_graph", "Ended graph cannot be patched")
	}
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	if latest == nil {
		Raise("invalid_graph", "Graph "+runtime.graphId+" has no revision to patch")
	}
	if latest.Version != baseRevision {
		Raise("stale_revision", "Patch is based on revision "+itoa(baseRevision)+" but the current revision is "+itoa(latest.Version))
	}
	if stringsTrim(changes.Reason) == "" {
		Raise("invalid_input", "Graph change requires a reason")
	}
	if (changes.Definition != nil) == changes.HasPatch {
		Raise("invalid_input", "Supply exactly one full definition or local patch")
	}
	var parsed GraphDefinition
	if !changes.HasPatch {
		parsed = ParseGraphDefinition(*changes.Definition)
	} else {
		parsed = ParseGraphDefinition(patchedDefinition(latest.Definition, changes.Patch))
	}
	if len(latest.Definition.Acceptance) > 0 && CanonicalJSON(parsed.Acceptance) != CanonicalJSON(latest.Definition.Acceptance) {
		Raise("invalid_input", "Patch cannot change declared final acceptance")
	}
	for _, criterion := range latest.Definition.Acceptance {
		if criterion.Kind == "check" && CanonicalJSON(parsed.Modules[criterion.Module].Operation) != CanonicalJSON(latest.Definition.Modules[criterion.Module].Operation) {
			Raise("invalid_input", "Patch cannot change declared acceptance check "+criterion.Module)
		}
	}
	for _, id := range changes.Retire {
		_, node := latest.Definition.Nodes[id]
		_, module := latest.Definition.Modules[id]
		if !node && !module {
			Raise("invalid_graph", "Retire names unknown node or module "+id)
		}
	}
	return runtime.kernel.Store.Transaction(func() any {
		var removed []string
		for id := range latest.Definition.Nodes {
			if _, ok := parsed.Nodes[id]; !ok {
				if _, ok := parsed.Modules[id]; !ok {
					removed = append(removed, id)
				}
			}
		}
		for id := range latest.Definition.Modules {
			if _, ok := parsed.Nodes[id]; ok {
				continue
			}
			if _, ok := parsed.Modules[id]; ok {
				continue
			}
			removed = append(removed, id)
		}
		for _, id := range removed {
			if !containsString(changes.Retire, id) {
				Raise("invalid_graph", "Removing "+id+" requires explicit retire")
			}
			pending := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state IN ('queued','claimed','failed') LIMIT 1", runtime.graphId, id)
			inbox := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND module_id=? AND processed=0 LIMIT 1", runtime.graphId, id)
			running := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1", runtime.graphId, id)
			outbox := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND t.module_id=? AND o.routed=0 LIMIT 1", runtime.graphId, id)
			if pending != nil || inbox != nil || running != nil || outbox != nil {
				Raise("pending_work", "Cannot remove "+id+": settle or explicitly cancel its pending work first")
			}
		}
		revision := runtime.kernel.InsertRevision(runtime.graphId, parsed, changes.Reason)
		for id, node := range parsed.Nodes {
			if _, ok := latest.Definition.Nodes[id]; !ok {
				runtime.kernel.AdmitNode(runtime.graphId, revision.Version, id, AdmitNodeInput{InstanceId: graphUUID()})
			} else {
				encoded, err := json.Marshal(node)
				if err != nil {
					panic(err)
				}
				kernelExec(runtime.kernel.DB, "UPDATE kernel_nodes SET revision_version=?,spec=? WHERE task_id=? AND node_id=?", revision.Version, string(encoded), runtime.graphId, id)
			}
		}
		for id, module := range parsed.Modules {
			if _, ok := latest.Definition.Modules[id]; !ok {
				runtime.kernel.AdmitModule(runtime.graphId, revision.Version, id, AdmitModuleInput{ModuleType: module.Type, Trigger: module.Trigger})
			} else {
				kernelExec(runtime.kernel.DB, "UPDATE kernel_modules SET revision_version=?,module_type=?,trigger=? WHERE task_id=? AND module_id=?", revision.Version, module.Type, module.Trigger, runtime.graphId, id)
			}
		}
		for _, id := range removed {
			nodeId := id
			FinishNativePauses(runtime.kernel.Store, runtime.graphId, &nodeId)
		}
		for _, id := range removed {
			kernelExec(runtime.kernel.DB, "UPDATE kernel_nodes SET status='retired' WHERE task_id=? AND node_id=?", runtime.graphId, id)
		}
		runtime.kernel.Store.Event(runtime.graphId, "graph.patched", map[string]any{"revision": revision.Version, "previousRevision": latest.Version, "reason": changes.Reason})
		return struct{ Revision int }{Revision: revision.Version}
	}).(struct{ Revision int })
}

// State reads phase, pause, and the latest revision.
func (runtime *GraphRuntime) State() *GraphStateRow {
	row := kernelRow(runtime.kernel.DB, "SELECT phase,paused FROM tasks WHERE id=?", runtime.graphId)
	if row == nil {
		return nil
	}
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	phase := GraphPhase(kernelString(row["phase"]))
	if kernelInt(row["paused"]) != 0 && phase != "completed" && phase != "stopping" && phase != "stopped" {
		phase = "paused"
	}
	revision := 0
	if latest != nil {
		revision = latest.Version
	}
	return &GraphStateRow{GraphId: runtime.graphId, Phase: phase, Revision: revision}
}

func (runtime *GraphRuntime) setPhase(phase GraphPhase) {
	runtime.kernel.Store.SetTaskPhase(runtime.graphId, string(phase))
	if phase == "completed" || phase == "stopped" {
		FinishNativePauses(runtime.kernel.Store, runtime.graphId, nil)
		ReleaseTaskSlot(runtime.kernel.Store, runtime.graphId)
	}
}

func (runtime *GraphRuntime) completionRequested() bool {
	row := kernelRow(runtime.kernel.DB, "SELECT completion_requested AS requested FROM kernel_lifecycle WHERE task_id=?", runtime.graphId)
	return row != nil && kernelInt(row["requested"]) == 1
}

// Deliver accepts an external interface input.
func (runtime *GraphRuntime) Deliver(nodeId, input string, value any) QueueRow {
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	if latest == nil {
		Raise("invalid_input", "Unknown agent "+nodeId)
	}
	if _, ok := latest.Definition.Nodes[nodeId]; !ok {
		Raise("invalid_input", "Unknown agent "+nodeId)
	}
	delivered := runtime.DeliverEndpoint(nodeId+"."+input, value)
	return *delivered.Queue
}

// DeliverEndpoint refuses delivery once completion or stop has begun.
func (runtime *GraphRuntime) DeliverEndpoint(endpoint string, value any) DirectDelivery {
	phase := GraphPhase("running")
	if state := runtime.State(); state != nil {
		phase = state.Phase
	}
	if runtime.completionRequested() || phase == "completing" || phase == "completed" {
		Raise("completing", "Graph "+runtime.graphId+" is completing; external delivery is closed")
	}
	if phase == "stopping" || phase == "stopped" {
		Raise("stopping", "Graph "+runtime.graphId+" is stopping; external delivery is closed")
	}
	return runtime.kernel.DeliverDirect(runtime.graphId, endpoint, value)
}

// Chat queues a message. External chat closes during completion unless internal is set.
func (runtime *GraphRuntime) Chat(nodeId, text string, internal bool) QueueRow {
	phase := GraphPhase("running")
	if state := runtime.State(); state != nil {
		phase = state.Phase
	}
	if phase == "completed" || (!internal && (runtime.completionRequested() || phase == "completing")) {
		Raise("completing", "Graph "+runtime.graphId+" is completing; execution-triggering chat is closed")
	}
	if phase == "stopping" || phase == "stopped" {
		Raise("stopping", "Graph "+runtime.graphId+" is stopping; chat is closed")
	}
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	if latest == nil {
		Raise("invalid_input", "Unknown agent "+nodeId)
	}
	if _, ok := latest.Definition.Nodes[nodeId]; !ok {
		Raise("invalid_input", "Unknown agent "+nodeId)
	}
	return NewNodeQueue(runtime.kernel, runtime.graphId).Enqueue(QueueInput{NodeId: nodeId, Kind: "chat", Text: &text})
}

// Complete requests completion and closes external input.
func (runtime *GraphRuntime) Complete() GraphStateRow {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == "completed" {
		return *runtime.State()
	}
	if phase == "stopping" || phase == "stopped" {
		Raise("invalid_graph", "Stopped graph cannot complete")
	}
	kernelExec(runtime.kernel.DB, "INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1", runtime.graphId)
	runtime.setPhase("completing")
	return *runtime.State()
}

// WithdrawComplete restores external input.
func (runtime *GraphRuntime) WithdrawComplete() GraphStateRow {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == "completed" || phase == "stopping" || phase == "stopped" || !runtime.completionRequested() {
		Raise("invalid_graph", "Graph "+runtime.graphId+" is not completing")
	}
	kernelExec(runtime.kernel.DB, "UPDATE kernel_lifecycle SET completion_requested=0 WHERE task_id=?", runtime.graphId)
	runtime.setPhase("running")
	return *runtime.State()
}

// SettleCompletion settles only when the queue, executions, and module transitions are drained.
func (runtime *GraphRuntime) SettleCompletion() string {
	runtime.ensureTask()
	if runtime.State().Phase == "completed" {
		return "completed"
	}
	phase := runtime.State().Phase
	if phase == "stopping" || phase == "stopped" {
		Raise("invalid_graph", "Stopped graph cannot complete")
	}
	if !runtime.completionRequested() {
		Raise("invalid_graph", "Graph "+runtime.graphId+" is not completing")
	}
	queued := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", runtime.graphId)["n"])
	running := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state='running'", runtime.graphId)["n"])
	pausedOrFailed := kernelInt(kernelRow(runtime.kernel.DB, `SELECT COUNT(*) AS n FROM (
      SELECT node_id FROM kernel_node_state WHERE task_id=? AND paused=1
      UNION SELECT node_id FROM kernel_nodes WHERE task_id=? AND status IN ('blocked','failed')
    )`, runtime.graphId, runtime.graphId)["n"])
	failedInputs := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_queue WHERE task_id=? AND state='failed' LIMIT 1", runtime.graphId)
	task := runtime.kernel.Store.Task(runtime.graphId)
	currentCommit := task.IntegrationSha
	humanQuestions := kernelRows(runtime.kernel.DB, "SELECT id,data FROM questions WHERE task_id=? AND kind='human_check' AND status='open'", runtime.graphId)
	runtime.kernel.ModuleTransaction(func() any {
		for _, question := range humanQuestions {
			var data map[string]any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			acceptanceId, _ := data["acceptanceId"].(string)
			if acceptanceId == "" {
				continue
			}
			// TypeScript reads (data.commitSha ?? null) === currentCommit, so a
			// missing key and an explicit null are the same value.
			var previousCommit *string
			if raw, ok := data["commitSha"]; ok && raw != nil {
				text, _ := raw.(string)
				previousCommit = &text
			}
			if graphAcceptanceShaEqual(previousCommit, currentCommit) {
				continue
			}
			var commit any = currentCommit
			kernelExec(runtime.kernel.DB, "UPDATE questions SET status='resolved',answer=? WHERE id=? AND status='open'", CanonicalJSON(map[string]any{"type": "superseded", "reason": "Integration commit changed", "commitSha": commit}), question["id"])
			var previousCommitValue any = previousCommit
			runtime.kernel.Store.Event(runtime.graphId, "graph.acceptance.superseded", map[string]any{"questionId": kernelString(question["id"]), "acceptanceId": acceptanceId, "previousCommit": previousCommitValue, "commit": commit})
		}

		return nil
	})
	openQuestion := kernelRow(runtime.kernel.DB, "SELECT 1 FROM questions WHERE task_id=? AND status='open' LIMIT 1", runtime.graphId)
	if pausedOrFailed > 0 || failedInputs != nil || openQuestion != nil {
		runtime.setPhase("blocked")
		return "blocked"
	}
	pendingModules := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_module_inbox WHERE task_id=? AND processed=0", runtime.graphId)["n"])
	pendingOutputs := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0", runtime.graphId)["n"])
	if queued > 0 || running > 0 || pendingModules > 0 || pendingOutputs > 0 {
		return "completing"
	}
	acceptance := GraphAcceptance(runtime.kernel, runtime.graphId, runtime.artifacts)
	delivery := kernelRow(runtime.kernel.DB, "SELECT commit_sha FROM kernel_completion_delivery WHERE task_id=?", runtime.graphId)
	task = runtime.kernel.Store.Task(runtime.graphId)
	deliveryMatches := true
	hasIntegrationBranch := task.IntegrationBranch != nil && *task.IntegrationBranch != ""
	deliveryCommit := (*string)(nil)
	if delivery != nil && delivery["commit_sha"] != nil {
		text := kernelString(delivery["commit_sha"])
		deliveryCommit = &text
	}
	if hasIntegrationBranch && (!graphAcceptanceShaEqual(task.TargetSha, acceptance.Commit) || delivery == nil || !graphAcceptanceShaEqual(deliveryCommit, acceptance.Commit)) {
		deliveryMatches = false
	}
	if !acceptance.Ready || !deliveryMatches {
		runtime.kernel.ModuleTransaction(func() any {
			readyHuman := true
			for _, item := range acceptance.Items {
				if item.Status != "passed" && item.Kind != "human" {
					readyHuman = false
				}
			}
			if readyHuman {
				for _, criterion := range acceptance.Human {
					InsertQuestion(runtime.kernel.Store, QuestionInput{TaskId: runtime.graphId, NodeId: "@acceptance/" + criterion.Id, Kind: "human_check", Data: map[string]any{"prompt": criterion.Description, "acceptanceId": criterion.Id, "commitSha": acceptance.Commit}})
				}
			}
			if runtime.State().Phase != "blocked" {
				var commit any = acceptance.Commit
				data := map[string]any{"graphId": runtime.graphId, "commit": commit, "items": acceptance.Items, "deliveryPending": acceptance.Ready}
				runtime.kernel.Store.Event(runtime.graphId, "graph.acceptance.blocked", data)
				sum := sha256.Sum256([]byte(CanonicalJSON(data)))
				WakeMaster(runtime.kernel.Store, WakeIntent{TaskID: runtime.graphId, Kind: "acceptance_blocked", DedupeKey: runtime.graphId + ":acceptance:" + hex.EncodeToString(sum[:]), Data: data, HasData: true})
			}
			runtime.setPhase("blocked")

			return nil
		})
		return "blocked"
	}
	runtime.kernel.ModuleTransaction(func() any {
		runtime.setPhase("completed")
		task := runtime.kernel.Store.Task(runtime.graphId)
		var sha any
		if task.IntegrationSha != nil {
			sha = *task.IntegrationSha
		}
		WakeForTaskCompleted(runtime.kernel.Store, runtime.graphId, map[string]any{"phase": "completed", "integrationSha": sha})
		runtime.kernel.Store.Event(runtime.graphId, "graph.completed", map[string]any{"revision": runtime.State().Revision})

		return nil
	})
	return "completed"
}

// Stop cancels queued work and blocks new dispatch.
func (runtime *GraphRuntime) Stop() GraphStateRow {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == "completed" || phase == "stopped" {
		return *runtime.State()
	}
	FinishNativePauses(runtime.kernel.Store, runtime.graphId, nil)
	runtime.kernel.Store.StopTask(runtime.graphId)
	kernelExec(runtime.kernel.DB, "UPDATE kernel_module_inbox SET processed=1 WHERE task_id=?", runtime.graphId)
	kernelExec(runtime.kernel.DB, "UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id IN (SELECT id FROM kernel_module_transitions WHERE task_id=?)", runtime.graphId)
	kernelExec(runtime.kernel.Store.DB, "UPDATE kernel_queue SET state='done',reason='cancelled by stop' WHERE task_id=? AND state='queued'", runtime.graphId)
	runtime.kernel.Store.Event(runtime.graphId, "graph.stopping", map[string]any{})
	return *runtime.State()
}

// SettleStop settles once queued work is cancelled and in-flight executions stop.
func (runtime *GraphRuntime) SettleStop() string {
	runtime.ensureTask()
	if runtime.State().Phase == "stopped" {
		return "stopped"
	}
	if runtime.State().Phase != "stopping" {
		Raise("invalid_graph", "Graph "+runtime.graphId+" is not stopping")
	}
	kernelExec(runtime.kernel.DB, "UPDATE kernel_queue SET state='done',reason='cancelled by stop' WHERE task_id=? AND state='queued'", runtime.graphId)
	queued := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", runtime.graphId)["n"])
	running := kernelInt(kernelRow(runtime.kernel.DB, "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state='running'", runtime.graphId)["n"])
	if queued > 0 || running > 0 {
		return "stopping"
	}
	runtime.kernel.ModuleTransaction(func() any {
		runtime.setPhase("stopped")
		WakeMaster(runtime.kernel.Store, WakeIntent{TaskID: runtime.graphId, Kind: "task_stopped", DedupeKey: runtime.graphId + ":stopped", Data: map[string]any{"graphId": runtime.graphId}, HasData: true})
		runtime.kernel.Store.Event(runtime.graphId, "graph.stopped", map[string]any{"revision": runtime.State().Revision})

		return nil
	})
	return "stopped"
}

// Inspect reads summary, revision, or nodes.
func (runtime *GraphRuntime) Inspect(kind string) any {
	runtime.ensureTask()
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	switch kind {
	case "summary":
		return map[string]any{"graphId": runtime.graphId, "phase": runtime.State().Phase, "revision": latest.Version, "name": latest.Definition.Name}
	case "revision":
		return latest.Definition
	case "nodes":
		rows := kernelRows(runtime.kernel.DB, "SELECT node_id, instance_id, kind, status FROM kernel_nodes WHERE task_id=?", runtime.graphId)
		out := make([]any, len(rows))
		for i, row := range rows {
			out[i] = map[string]any{"id": kernelString(row["node_id"]), "instanceId": kernelString(row["instance_id"]), "kind": kernelString(row["kind"]), "status": kernelString(row["status"])}
		}
		return out
	default:
		Raise("invalid_query", "Unknown inspect query "+kind)
	}
	return nil
}

func patchedDefinition(definition GraphDefinition, input any) any {
	if input == nil {
		Raise("invalid_input", "Graph patch must be a JSON object")
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		Raise("invalid_input", "Graph patch must contain serializable JSON")
	}
	var patch map[string]any
	if err := json.Unmarshal(encoded, &patch); err != nil {
		Raise("invalid_input", "Graph patch must be a JSON object")
	}
	base, err := json.Marshal(definition)
	if err != nil {
		Raise("invalid_input", "Graph patch must contain serializable JSON")
	}
	var result map[string]any
	if err := json.Unmarshal(base, &result); err != nil {
		panic(err)
	}
	type frame struct {
		target map[string]any
		patch  map[string]any
	}
	pending := []frame{{target: result, patch: patch}}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		for key, value := range current.patch {
			if value == nil {
				delete(current.target, key)
				continue
			}
			nested, isObject := value.(map[string]any)
			if isObject {
				existing, _ := current.target[key].(map[string]any)
				if existing == nil {
					existing = map[string]any{}
				}
				current.target[key] = existing
				pending = append(pending, frame{target: existing, patch: nested})
				continue
			}
			current.target[key] = value
		}
	}
	return result
}

func stringsTrim(value string) string {
	start := 0
	end := len(value)
	for start < end {
		c := value[start]
		if c != ' ' && c != '\n' && c != '\t' && c != '\r' {
			break
		}
		start++
	}
	for end > start {
		c := value[end-1]
		if c != ' ' && c != '\n' && c != '\t' && c != '\r' {
			break
		}
		end--
	}
	return value[start:end]
}
