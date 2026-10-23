package graph

import "database/sql"

// GraphLaneOptions is the production hookup the host loop uses to drain v2 graphs.
type GraphLaneOptions struct {
	Kernel          *KernelStore
	SettleWorkspace func(executionId string)
	Close           func()
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

// RunnableGraph is one graph the lane is willing to run.
type RunnableGraph struct {
	TaskId string
	Run    func() RunResult
}

// GraphLane names v2 graphs that have queued work and builds the runner that drains one.
type GraphLane struct {
	options  GraphLaneOptions
	shutdown *AbortSignal
}

func NewGraphLane(options GraphLaneOptions) *GraphLane {
	return &GraphLane{options: options, shutdown: NewAbortSignal()}
}

// Close releases resident processes owned by this lane.
func (lane *GraphLane) Close() {
	lane.shutdown.Abort()
	if lane.options.Close != nil {
		lane.options.Close()
	}
}

// Runnable lists v2 graphs that currently have queued work.
func (lane *GraphLane) Runnable() []RunnableGraph {
	if lane.shutdown.Aborted() {
		return nil
	}
	kernel := lane.options.Kernel
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
		task, ok := graphDBRow(db, "SELECT phase, paused FROM tasks WHERE id=?", taskId)
		if !ok || graphDBInt(task, "paused") != 0 {
			continue
		}
		phase := graphDBString(task, "phase")
		if phase != "running" && phase != "idle" && phase != "blocked" && phase != "completing" && phase != "stopping" {
			continue
		}
		if kernel.LatestRevision(taskId) == nil {
			continue
		}
		if OccupiedSlots(kernel.Store, "agent") >= int64(ExecutionLimit("agent")) {
			_, queued := graphDBRow(db, "SELECT 1 FROM kernel_queue WHERE task_id=? AND state='queued' LIMIT 1", taskId)
			_, inbox := graphDBRow(db, "SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND processed=0 LIMIT 1", taskId)
			_, outbox := graphDBRow(db, "SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0 LIMIT 1", taskId)
			if queued && !inbox && !outbox && phase != "stopping" {
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
	lane.options.Kernel.Store.StartTaskPhase(graphId, "running", "idle")
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
	if state := runtime.State(); state != nil && state.Phase == "stopping" {
		runtime.SettleStop()
	} else if intent && runtime.State() != nil && runtime.State().Phase != "completed" && runtime.State().Phase != "stopped" {
		if lane.options.Finalize != nil {
			lane.options.Finalize(graphId)
		}
		if phase := runtime.State().Phase; phase != "stopping" && phase != "stopped" {
			runtime.SettleCompletion()
		}
	}
	if state := runtime.State(); state != nil && (state.Phase == "completed" || state.Phase == "stopped") {
		if lane.options.CloseGraph != nil {
			lane.options.CloseGraph(graphId)
		}
	} else if !intent && result.Drained {
		lane.options.Kernel.Store.StartTaskPhase(graphId, "idle", "running")
	}
	return result
}

func (lane *GraphLane) db() *sql.DB {
	return lane.options.Kernel.Store.Db
}
