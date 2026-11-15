package graph

import (
	"os"
)

func (runtime *TaskRuntime) pump() ExecutionDispatch {
	if runtime.execution == nil {
		return ExecutionDispatch{}
	}
	return runtime.execution.Pump()
}

func (runtime *TaskRuntime) ensureOpen() {
	runtime.mu.Lock()
	closed := runtime.closed
	runtime.mu.Unlock()
	if closed {
		Raise("closed", "Runtime is closed")
	}
}

func (runtime *TaskRuntime) Close() {
	runtime.mu.Lock()
	if runtime.closed {
		runtime.mu.Unlock()
		return
	}
	runtime.closed = true
	runtime.mu.Unlock()
	if runtime.execution != nil {
		runtime.execution.Drain()
		runtime.execution.SettleGraphShutdown()
	}
	runtime.store.Close()
}

func taskRuntimeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func (runtime *TaskRuntime) taskRuntimeInvocations(taskId string) []map[string]any {
	nodes := map[string]string{}
	for _, node := range runtime.kernel.ListNodes(taskId) {
		nodes[node.NodeId] = node.InstanceId
	}
	out := []map[string]any{}
	for _, row := range InvocationRows(runtime.store, taskId) {
		out = append(out, map[string]any{
			"id":          row.Id,
			"operationId": row.OperationId,
			"instanceId":  row.InstanceId,
			"model":       row.Model,
			"usage":       row.Usage,
			"usageSource": string(row.UsageSource),
			"cost":        row.Cost,
		})
	}
	for _, call := range runtime.kernel.ProviderCalls(taskId) {
		model := "unknown"
		if call.Model != nil {
			model = call.Model.Id
		}
		instanceId := nodes[call.NodeId]
		out = append(out, map[string]any{
			"id":          call.Id,
			"operationId": call.ExecutionId,
			"instanceId":  instanceId,
			"model":       model,
			"usage":       call.Usage,
			"usageSource": "unknown",
			"cost":        map[string]any{"unknown": true},
		})
	}
	return out
}

type TaskRuntimeUser struct {
	runtime *TaskRuntime
}
