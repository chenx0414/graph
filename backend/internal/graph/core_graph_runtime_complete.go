package graph

import (
	"encoding/hex"
	"encoding/json"

	"crypto/sha256"
)

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
			runtime.kernel.Store.ResolveOpenQuestion(kernelString(question["id"]), map[string]any{"type": "superseded", "reason": "Integration commit changed", "commitSha": commit})
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
	task = runtime.kernel.Store.Task(runtime.graphId)
	// A waived item is not evidence: acceptance.Ready counts only passed items,
	// so a graph with recorded limitations still reaches this hard gate and stays
	// blocked until someone uses complete_with_limitations explicitly.
	if !acceptance.Ready || !graphAcceptanceDeliveryMatches(task, acceptance) {
		runtime.kernel.ModuleTransaction(func() any {
			readyHuman := true
			for _, item := range acceptance.Items {
				// A waived item is settled for this commit: it is not a debt, and it
				// does not ask the user anything again.
				if item.Status == "passed" || item.Status == "waived" {
					continue
				}
				if item.Kind != "human" {
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
