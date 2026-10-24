package graph

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
	runtime.kernel.RequestGraphCompletion(runtime.graphId)
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
	runtime.kernel.ClearGraphCompletionRequest(runtime.graphId)
	runtime.setPhase("running")
	return *runtime.State()
}
