package graph

func (runtime *GraphRuntime) State() *GraphStateRow {
	row := kernelRow(runtime.kernel.DB, "SELECT phase,paused FROM tasks WHERE id=?", runtime.graphId)
	if row == nil {
		return nil
	}
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	phase := displayPhase(kernelString(row["phase"]), kernelInt(row["paused"]) != 0)
	revision := 0
	if latest != nil {
		revision = latest.Version
	}
	return &GraphStateRow{GraphId: runtime.graphId, Phase: phase, Revision: revision}
}

func (runtime *GraphRuntime) setPhase(phase GraphPhase) {
	runtime.kernel.Store.SetTaskPhase(runtime.graphId, string(phase))
	if phase == PhaseCompleted || phase == PhaseStopped {
		runtime.kernel.FinishNativePauses(runtime.graphId, nil)
		ReleaseTaskSlot(runtime.kernel.Store, runtime.graphId)
	}
}

func (runtime *GraphRuntime) completionRequested() bool {
	row := kernelRow(runtime.kernel.DB, "SELECT completion_requested AS requested FROM kernel_lifecycle WHERE task_id=?", runtime.graphId)
	return row != nil && kernelInt(row["requested"]) == 1
}

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

func (runtime *GraphRuntime) DeliverEndpoint(endpoint string, value any) DirectDelivery {
	requireProjectActive(runtime.kernel.Store, runtime.kernel.Store.Task(runtime.graphId).ProjectID)
	phase := GraphPhase("running")
	if state := runtime.State(); state != nil {
		phase = state.Phase
	}
	if runtime.completionRequested() || phase.CompletionClosed() {
		Raise("completing", "Graph "+runtime.graphId+" is completing; external delivery is closed")
	}
	if phase.Cancelling() {
		Raise("stopping", "Graph "+runtime.graphId+" is stopping; external delivery is closed")
	}
	return runtime.kernel.DeliverDirect(runtime.graphId, endpoint, value)
}

func (runtime *GraphRuntime) Chat(nodeId, text string, internal bool) QueueRow {
	requireProjectActive(runtime.kernel.Store, runtime.kernel.Store.Task(runtime.graphId).ProjectID)
	phase := GraphPhase("running")
	if state := runtime.State(); state != nil {
		phase = state.Phase
	}
	if phase == PhaseCompleted || (!internal && (runtime.completionRequested() || phase == PhaseCompleting)) {
		Raise("completing", "Graph "+runtime.graphId+" is completing; execution-triggering chat is closed")
	}
	if phase.Cancelling() {
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

func (runtime *GraphRuntime) Complete() GraphStateRow {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == PhaseCompleted {
		return *runtime.State()
	}
	if phase.Cancelling() {
		Raise("invalid_graph", "Stopped graph cannot complete")
	}
	runtime.kernel.RequestGraphCompletion(runtime.graphId)
	runtime.setPhase(PhaseCompleting)
	return *runtime.State()
}

func (runtime *GraphRuntime) WithdrawComplete() GraphStateRow {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase.Closed() || !runtime.completionRequested() {
		Raise("invalid_graph", "Graph "+runtime.graphId+" is not completing")
	}
	runtime.kernel.ClearGraphCompletionRequest(runtime.graphId)
	runtime.setPhase(PhaseRunning)
	return *runtime.State()
}
