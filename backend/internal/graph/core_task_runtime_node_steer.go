package graph

import (
	"hash/fnv"
	"strings"
	"sync"
)

var nodeSteerLocks [64]sync.Mutex

func nodeCommandLock(scope, requestID string) *sync.Mutex {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(scope + ":" + requestID))
	return &nodeSteerLocks[hash.Sum32()%uint32(len(nodeSteerLocks))]
}

func (runtime *TaskRuntime) steerGraphNode(caller, graphID, nodeID, text, requestID string) any {
	scope := "node-steer:" + caller
	lock := nodeCommandLock(scope, requestID)
	lock.Lock()
	defer lock.Unlock()
	payload := map[string]any{"graphId": graphID, "nodeId": nodeID, "text": text}
	intent := runtime.store.Command(scope+":intent", requestID, payload, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		execution := runtime.kernel.RunningExecution(graphID, nodeID)
		if execution == nil {
			Raise("steering_unavailable", "This node has no running turn to steer")
		}
		return map[string]any{"executionId": execution.Id}
	})
	intentRecord, _ := jsonRecord(intent)
	executionID := kernelString(intentRecord["executionId"])
	prior := kernelRow(runtime.store.Db, "SELECT receipt FROM commands WHERE scope=? AND request_id=?", scope+":result", requestID)
	if prior != nil {
		return runtime.store.Command(scope+":result", requestID, payload, func(tx *TaskStore) any { return nil })
	}
	lane := runtime.residentGraphLane()
	if lane.options.Steer == nil {
		Raise("steering_unavailable", "The graph lane cannot steer this node")
	}
	if err := lane.options.Steer(graphID, nodeID, executionID, text, ContentDigest(scope+":"+requestID)); err != nil {
		Raise("steering_unavailable", err.Error())
	}
	return runtime.store.Command(scope+":result", requestID, payload, func(tx *TaskStore) any {
		runtime := runtime.scoped(tx)
		actor := "agent"
		if strings.HasPrefix(caller, "user:") {
			actor = "user"
		}
		AppendNodeEntry(runtime.store, NodeEntryInput{TaskID: graphID, NodeID: nodeID, OperationID: executionID, Role: "user", Kind: "chat", Text: text, Data: map[string]any{"source": actor, "mode": "steer", "requestId": requestID}})
		return map[string]any{"taskId": graphID, "nodeId": nodeID, "operationId": executionID, "steered": true,
			"cursor": runtime.store.Event(graphID, "operation.steered", map[string]any{"nodeId": nodeID, "operationId": executionID, "actor": actor, "text": text})}
	})
}
