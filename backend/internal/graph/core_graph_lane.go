package graph

type GraphLaneOptions struct {
	Kernel          *KernelStore
	SettleWorkspace func(executionId string)
	Close           func()
	Steer           func(graphId, nodeId, executionId, text, requestId string) error
	StopNode        func(graphId, nodeId, executionId string, attempt int) error
	Operation       func(graphId string, request ModuleOperationRequest) ModuleOperationResponse
	CloseGraph      func(graphId string)
	Finalize        func(graphId string)
	TokenBudget     *TokenBudget
	ReserveTokens   *float64
	Host            func(graphId, nodeId string, config any, revisionVersion int) ExecutorHost
	Config          func(graphId, nodeId string, revisionVersion int) any
	InitialContext  func(graphId, nodeId string) string
	Workspace       func(graphId, nodeId string) *string
	Artifacts       func(graphId string) *ArtifactWorkspace
	MaxStuckPasses  *int
}

type RunnableGraph struct {
	TaskId string
	Run    func() RunResult
}

type GraphLane struct {
	options  GraphLaneOptions
	shutdown *AbortSignal
}

func NewGraphLane(options GraphLaneOptions) *GraphLane {
	return &GraphLane{options: options, shutdown: NewAbortSignal()}
}

func (lane *GraphLane) Close() {
	lane.shutdown.Abort()
	if lane.options.Close != nil {
		lane.options.Close()
	}
}

func (lane *GraphLane) Runnable() []RunnableGraph {
	if lane.shutdown.Aborted() {
		return nil
	}
	kernel := lane.options.Kernel
	kernel.Store.txMu.Lock()
	defer kernel.Store.txMu.Unlock()
	db := kernel.Store.Db
	rows := graphDBAll(db, `SELECT q.task_id FROM kernel_queue q LEFT JOIN kernel_node_state s ON s.task_id=q.task_id AND s.node_id=q.node_id
        WHERE q.state='queued' AND COALESCE(s.paused,0)=0 AND NOT EXISTS(SELECT 1 FROM kernel_nodes n WHERE n.task_id=q.task_id AND n.node_id=q.node_id AND n.status='blocked')
      UNION SELECT i.task_id FROM kernel_module_inbox i LEFT JOIN kernel_node_state s ON s.task_id=i.task_id AND s.node_id=i.module_id
        WHERE i.processed=0 AND COALESCE(s.paused,0)=0
      UNION SELECT t.task_id FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id
        LEFT JOIN kernel_node_state s ON s.task_id=t.task_id AND s.node_id=t.module_id WHERE o.routed=0 AND COALESCE(s.paused,0)=0
      UNION SELECT id AS task_id FROM tasks WHERE phase IN ('completing','stopping')
      ORDER BY task_id`)
	graphs := []RunnableGraph{}
	for _, row := range rows {
		taskId := graphDBString(row, "task_id")
		task, ok := graphDBRow(db, "SELECT phase, paused, project_id, target_branch, integration_branch FROM tasks WHERE id=?", taskId)
		if !ok || graphDBInt(task, "paused") != 0 || projectArchived(kernel.Store, graphDBString(task, "project_id")) {
			continue
		}
		phase := GraphPhase(graphDBString(task, "phase"))
		if task["target_branch"] != nil && task["integration_branch"] == nil && phase != PhaseStopping {
			continue
		}
		if !phase.LaneEligible() {
			continue
		}
		if kernel.LatestRevision(taskId) == nil {
			continue
		}
		if kernel.Store.FreeExecutionSlots("agent") <= 0 {
			_, queued := graphDBRow(db, "SELECT 1 FROM kernel_queue WHERE task_id=? AND state='queued' LIMIT 1", taskId)
			_, inbox := graphDBRow(db, "SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND processed=0 LIMIT 1", taskId)
			_, outbox := graphDBRow(db, "SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0 LIMIT 1", taskId)
			if queued && !inbox && !outbox && phase != PhaseStopping {
				continue
			}
		}
		id := taskId
		graphs = append(graphs, RunnableGraph{TaskId: id, Run: func() RunResult { return lane.runGraph(id) }})
	}
	return graphs
}

func (lane *GraphLane) runGraph(graphId string) RunResult {
	kernel := lane.options.Kernel
	revision := kernel.LatestRevision(graphId)
	if revision == nil {
		return RunResult{Drained: true}
	}
	lane.options.Kernel.Store.StartTaskPhase(graphId, string(PhaseRunning), string(PhaseIdle))
	options := GraphRunnerOptions{
		Kernel: kernel, GraphId: graphId, Signal: lane.shutdown,
		Submit: func(string) *TurnInjection { return nil },
		HostFor: func(nodeId string, revisionVersion int) ExecutorHost {
			config := lane.options.Config(graphId, nodeId, revisionVersion)
			if lane.shutdown.Aborted() {
				panic(errorString("Graph runtime is closing"))
			}
			return lane.options.Host(graphId, nodeId, config, revisionVersion)
		},
	}
	if lane.options.SettleWorkspace != nil {
		options.SettleWorkspace = lane.options.SettleWorkspace
	}
	if lane.options.Operation != nil {
		options.Operation = func(request ModuleOperationRequest) ModuleOperationResponse {
			return lane.options.Operation(graphId, request)
		}
	}
	if lane.options.TokenBudget != nil && lane.options.ReserveTokens != nil {
		options.TokenBudget = lane.options.TokenBudget
		options.ReserveTokens = lane.options.ReserveTokens
	}
	if lane.options.Workspace != nil {
		options.Workspace = func(nodeId string) *string { return lane.options.Workspace(graphId, nodeId) }
	}
	if lane.options.Artifacts != nil {
		options.Artifacts = func() *ArtifactWorkspace { return lane.options.Artifacts(graphId) }
	}
	if lane.options.InitialContext != nil {
		options.InitialContext = func(nodeId string) string { return lane.options.InitialContext(graphId, nodeId) }
	}
	if lane.options.MaxStuckPasses != nil {
		options.MaxStuckPasses = lane.options.MaxStuckPasses
	}
	result := NewGraphRunner(options).Drain()
	var artifacts *ArtifactWorkspace
	if lane.options.Artifacts != nil {
		artifacts = lane.options.Artifacts(graphId)
	}
	runtime := NewGraphRuntime(kernel, graphId, artifacts)
	intentRow, _ := graphDBRow(lane.db(), "SELECT completion_requested AS requested FROM kernel_lifecycle WHERE task_id=?", graphId)
	intent := graphDBInt(intentRow, "requested") != 0
	if state := runtime.State(); state != nil && state.Phase == PhaseStopping {
		runtime.SettleStop()
	} else if intent && runtime.State() != nil && runtime.State().Phase != PhaseCompleted && runtime.State().Phase != PhaseStopped {
		if lane.options.Finalize != nil {
			lane.options.Finalize(graphId)
		}
		if phase := runtime.State().Phase; !phase.Cancelling() {
			runtime.SettleCompletion()
		}
	}
	if state := runtime.State(); state != nil && (state.Phase == PhaseCompleted || state.Phase == PhaseStopped) {
		if lane.options.CloseGraph != nil {
			lane.options.CloseGraph(graphId)
		}
	} else if !intent && result.Drained {
		if lane.options.Artifacts != nil && acceptanceFailed(graphId, lane) {
			lane.options.Kernel.Store.BlockTaskPhase(graphId)
			lane.options.Kernel.Store.Event(graphId, "graph.stalled", map[string]any{"reason": "An acceptance check failed; the graph cannot close on its own"})
		} else {
			lane.options.Kernel.Store.SettleDrainedPhase(graphId)
		}
	}
	return result
}

func (lane *GraphLane) db() sqlh {
	return lane.options.Kernel.Store.Db
}

func acceptanceFailed(graphId string, lane *GraphLane) bool {
	report := GraphAcceptance(lane.options.Kernel, graphId, lane.options.Artifacts(graphId))
	for _, item := range report.Items {
		if item.Status == "failed" {
			return true
		}
	}
	return false
}
