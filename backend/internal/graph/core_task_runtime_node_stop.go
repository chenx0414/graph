package graph

import "strings"

func (runtime *TaskRuntime) stopGraphNode(caller, graphID, nodeID, requestID string) any {
	scope := "node-stop:" + caller
	lock := nodeCommandLock(scope, requestID)
	lock.Lock()
	defer lock.Unlock()
	payload := map[string]any{"graphId": graphID, "nodeId": nodeID}
	result := runtime.store.Command(scope, requestID, payload, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		actor := "agent"
		if strings.HasPrefix(caller, "user:") {
			actor = "user"
		}
		revision := runtime.kernel.LatestRevision(graphID)
		if revision == nil {
			Raise("invalid_graph", "A graph is required")
		}
		if _, ok := revision.Definition.Nodes[nodeID]; !ok {
			Raise("invalid_input", "The graph does not contain this node")
		}
		executionID := ""
		attempt := 0
		if execution := runtime.kernel.RunningExecution(graphID, nodeID); execution != nil {
			executionID = execution.Id
			attempt = execution.Attempt
		}
		runtime.kernel.SetQuestionManualPause(graphID, nodeID, true)
		runtime.kernel.SetNodeQueuePausedInCurrentTransaction(graphID, nodeID, true)
		runtime.kernel.SetNativePause(graphID, true, nodeID, 0)
		return map[string]any{"taskId": graphID, "nodeId": nodeID, "executionId": executionID, "attempt": attempt,
			"cursor": runtime.store.Event(graphID, "graph.node.stop_requested", map[string]any{"nodeId": nodeID, "executionId": executionID, "actor": actor})}
	})
	receipt, _ := jsonRecord(result)
	if kernelRow(runtime.store.Db, "SELECT receipt FROM commands WHERE scope=? AND request_id=?", scope+":dispatched", requestID) != nil {
		return result
	}
	executionID := kernelString(receipt["executionId"])
	if executionID != "" {
		lane := runtime.residentGraphLane()
		if lane.options.StopNode == nil {
			Raise("stop_unavailable", "The node is paused but the running turn could not be interrupted; retry this request")
		}
		attempt := int(kernelInt(receipt["attempt"]))
		if err := lane.options.StopNode(graphID, nodeID, executionID, attempt); err != nil {
			current := runtime.kernel.RunningExecution(graphID, nodeID)
			if current != nil && current.Id == executionID && current.Attempt == attempt {
				Raise("stop_unavailable", "The node is paused but the running turn could not be interrupted; retry this request")
			}
		}
	}
	runtime.store.Command(scope+":dispatched", requestID, payload, func(tx *TaskStore) any { return map[string]any{"dispatched": true} })
	return result
}
