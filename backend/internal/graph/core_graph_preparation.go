package graph

import (
	"strings"
	"sync"
)

var graphPreparationLocks sync.Map

func (service *graphManagementService) prepareGraph(graphID, sourceOwner, requestID, targetBranch, projectID string, retryFailed bool) (reason string) {
	value, _ := graphPreparationLocks.LoadOrStore(graphID, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	if kernelRow(service.kernel.Db, `SELECT id FROM tasks WHERE id=? AND
 COALESCE((SELECT MAX(cursor) FROM events WHERE task_id=? AND type='graph.preparation.recovery_required'),0) >
 COALESCE((SELECT MAX(cursor) FROM events WHERE task_id=? AND type='graph.preparation.recovery_cleared'),0)`, graphID, graphID, graphID) != nil {
		return "Git preparation was interrupted; inspect its process and worktree before retrying"
	}
	current := service.kernel.FindCreateRequest(sourceOwner, requestID)
	if current == nil || current.GraphID != graphID {
		return "The original graph creation request is unavailable"
	}
	if current.State == "ready" {
		return ""
	}
	if current.State == "failed" && !retryFailed {
		return "Graph preparation failed; inspect the error and worktree before retrying"
	}
	admitted := service.kernel.Store.Transaction(func() any {
		if projectArchived(service.kernel.Store, projectID) || kernelRow(service.kernel.Db, "SELECT task_id FROM project_archive_pauses WHERE task_id=?", graphID) != nil {
			return false
		}
		return kernelRow(service.kernel.Db, `SELECT w.id FROM work_graphs g JOIN work_requests w ON w.id=g.work_id
 WHERE g.kernel_request_id=? AND g.owner_task_id=? AND w.execution_paused=1`, requestID, sourceOwner) == nil
	}).(bool)
	if !admitted {
		return "Graph preparation is paused; restore and resume its work before continuing"
	}
	if current.State == "failed" {
		service.kernel.Store.Transaction(func() any {
			service.kernel.MarkCreateRequestPreparing(sourceOwner, requestID)
			service.kernel.Store.Event(graphID, "graph.preparation.retry_started", map[string]any{"requestId": requestID})
			return nil
		})
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			reason = graphServiceErrorMessage(recovered)
			service.kernel.Store.Transaction(func() any {
				service.kernel.MarkCreateRequestFailed(sourceOwner, requestID, reason)
				service.kernel.Store.BlockTask(graphID)
				service.kernel.Store.Event(graphID, "graph.preparation.failed", map[string]any{"reason": reason, "requestId": requestID})
				return nil
			})
		}
	}()
	if service.prepare == nil {
		Raise("invalid_input", "Git preparation is unavailable")
	}
	service.prepare(graphID, targetBranch)
	service.kernel.Store.Transaction(func() any {
		service.kernel.MarkCreateRequestReady(sourceOwner, requestID)
		for _, work := range kernelRows(service.kernel.Db, "SELECT work_id,graph_key FROM work_graphs WHERE kernel_request_id=? AND owner_task_id=?", requestID, sourceOwner) {
			service.kernel.Store.settleWorkGraph(kernelString(work["work_id"]), kernelString(work["graph_key"]), graphID, "ready", nil, NowMillis())
			WakeMaster(service.kernel.Store, WakeIntent{TaskID: graphID, Kind: "graph_ready", DedupeKey: graphID + ":ready", Data: map[string]any{"graphId": graphID, "workId": work["work_id"]}, HasData: true})
		}
		pausedWork := kernelRow(service.kernel.Db, `SELECT w.id FROM work_graphs g JOIN work_requests w ON w.id=g.work_id
 WHERE g.kernel_request_id=? AND g.owner_task_id=? AND w.execution_paused=1`, requestID, sourceOwner)
		mayResume := !projectArchived(service.kernel.Store, projectID) && pausedWork == nil
		if service.kernel.Store.FinishGraphPreparation(graphID, mayResume) {
			service.kernel.SetNativePause(graphID, false, "", 0)
		}
		owner, ok := service.kernel.GraphOwner(graphID)
		if ok && owner != sourceOwner {
			WakeMaster(service.kernel.Store, WakeIntent{TaskID: graphID, Kind: "graph_ready", DedupeKey: graphID + ":ready", Data: map[string]any{"graphId": graphID}, HasData: true})
		}
		return nil
	})
	return ""
}

func (service *graphManagementService) retryGraphPreparation(graphID, proof string) any {
	proof = strings.TrimSpace(proof)
	if proof == "" {
		Raise("invalid_input", "Explain the inspection that makes preparation safe to retry")
	}
	if len([]rune(proof)) > 4000 {
		proof = string([]rune(proof)[:4000])
	}
	row := service.kernel.Store.Transaction(func() any {
		task := service.kernel.Store.Task(graphID)
		requireProjectActive(service.kernel.Store, task.ProjectID)
		if kernelRow(service.kernel.Db, "SELECT task_id FROM project_archive_pauses WHERE task_id=?", graphID) != nil {
			Raise("paused", "Resume the work before retrying its preparation")
		}
		request := kernelRow(service.kernel.Db, "SELECT owner_task_id,request_id,content,state FROM kernel_create_requests WHERE graph_id=? ORDER BY rowid LIMIT 1", graphID)
		if request == nil {
			Raise("not_found", "The graph creation request was not found")
		}
		if kernelString(request["state"]) != "ready" {
			service.kernel.Store.Event(graphID, "graph.preparation.recovery_cleared", map[string]any{"graphId": graphID, "proof": proof})
		}
		return request
	}).(map[string]any)
	if kernelString(row["state"]) == "ready" {
		return service.runtime(graphID).State()
	}
	content := questionParseRecord(kernelString(row["content"]))
	branch, ok := content["targetBranch"].(string)
	if !ok || branch == "" {
		Raise("invalid_input", "The creation request has no target branch")
	}
	reason := service.prepareGraph(graphID, kernelString(row["owner_task_id"]), kernelString(row["request_id"]), branch, service.kernel.Store.Task(graphID).ProjectID, true)
	if reason != "" {
		Raise("preparation_failed", reason)
	}
	return service.runtime(graphID).State()
}
