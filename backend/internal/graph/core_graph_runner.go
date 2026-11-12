package graph

import (
	"strings"
	"sync"

	"database/sql"
)

type ModuleOperationRequest struct {
	ModuleId        string
	DeliveryId      string
	RevisionVersion int
	Operation       *ModuleOperation
	Inputs          map[string]any
	State           any
	Signal          *AbortSignal
}

type ModuleOperationResponse struct {
	Ok          bool
	State       any
	Outputs     map[string]any
	Diagnostics []string
}

type GraphRunnerOptions struct {
	Kernel          *KernelStore
	GraphId         string
	SettleWorkspace func(executionId string)
	Signal          *AbortSignal
	Operation       func(ModuleOperationRequest) ModuleOperationResponse
	TokenBudget     *TokenBudget
	ReserveTokens   *float64
	HostFor         func(nodeId string, revisionVersion int) ExecutorHost
	Workspace       func(nodeId string) *string
	Artifacts       func() *ArtifactWorkspace
	Submit          func(executionId string) *TurnInjection
	InitialContext  func(nodeId string) string
	Modules         *ModuleRuntime
	MaxStuckPasses  *int
}

type RunResult struct {
	Drained      bool
	Executions   int
	BlockedNodes []string
}

type GraphRunner struct {
	options GraphRunnerOptions
}

func NewGraphRunner(options GraphRunnerOptions) *GraphRunner {
	if options.Signal == nil {
		options.Signal = NewAbortSignal()
	}
	return &GraphRunner{options: options}
}

func (runner *GraphRunner) nodeIds() []string {
	rows := graphDBAll(runner.kernelDB(), "SELECT node_id FROM kernel_nodes WHERE task_id=? AND status!='retired' ORDER BY node_id", runner.options.GraphId)
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, graphDBString(row, "node_id"))
	}
	return out
}

func (runner *GraphRunner) pausedNodes() []string {
	rows := graphDBAll(runner.kernelDB(), "SELECT node_id FROM kernel_node_state WHERE task_id=? AND paused=1", runner.options.GraphId)
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, graphDBString(row, "node_id"))
	}
	return out
}

func (runner *GraphRunner) queuedCount() int64 {
	row, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state='queued'", runner.options.GraphId)
	modules, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_module_inbox WHERE task_id=? AND processed=0", runner.options.GraphId)
	return graphDBInt(row, "n") + graphDBInt(modules, "n")
}

func (runner *GraphRunner) signature() string {
	queue, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')", runner.options.GraphId)
	transitions, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_module_transitions WHERE task_id=?", runner.options.GraphId)
	paused, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_node_state WHERE task_id=? AND paused=1", runner.options.GraphId)
	completed, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state!='running'", runner.options.GraphId)
	return itoa(int(graphDBInt(queue, "n"))) + ":" + itoa(int(graphDBInt(transitions, "n"))) + ":" + itoa(int(graphDBInt(paused, "n"))) + ":" + itoa(int(graphDBInt(completed, "n")))
}

func (runner *GraphRunner) Drain() RunResult {
	kernel := runner.options.Kernel
	revision := kernel.LatestRevision(runner.options.GraphId)
	if revision == nil {
		return RunResult{Drained: true}
	}
	maxStuck := 2
	if runner.options.MaxStuckPasses != nil {
		maxStuck = *runner.options.MaxStuckPasses
	}
	beforeRow, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=?", runner.options.GraphId)
	beforeExecutions := graphDBInt(beforeRow, "n")
	stuck := 0
	var mu sync.Mutex
	active := map[string]chan struct{}{}
	wake := make(chan struct{}, 1)
	notify := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	unsubscribe := kernel.Store.OnEvent(func(string) { notify() })
	defer unsubscribe()
	for {
		task := kernel.Store.Task(runner.options.GraphId)
		if runner.options.Signal.Aborted() || task.Paused != 0 || task.Phase == "stopping" || task.Phase == "stopped" || task.Phase == "completed" {
			runner.waitActive(&mu, active)
			break
		}
		modules := runner.options.Modules
		if modules == nil {
			latest := kernel.LatestRevision(runner.options.GraphId)
			modules = NewModuleRuntime(kernel, runner.options.GraphId, latest.Version)
		}
		before := runner.signature()
		for _, nodeId := range runner.nodeIds() {
			mu.Lock()
			_, running := active[nodeId]
			mu.Unlock()
			if running || kernel.NodeState(runner.options.GraphId, nodeId).Paused || kernel.NodeStatus(runner.options.GraphId, nodeId) == "blocked" {
				continue
			}
			if _, queued := graphDBRow(runner.kernelDB(), "SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state='queued' LIMIT 1", runner.options.GraphId, nodeId); !queued {
				continue
			}
			if kernel.Store.FreeExecutionSlots("agent") <= 0 {
				break
			}
			done := make(chan struct{})
			mu.Lock()
			active[nodeId] = done
			mu.Unlock()
			go func(nodeId string, done chan struct{}) {
				defer close(done)
				defer func() {
					if rec := recover(); rec != nil {
						kernel.SetNodeQueuePaused(runner.options.GraphId, nodeId, true)
						kernel.BlockNode(runner.options.GraphId, nodeId, panicMessage(rec))
					}
					mu.Lock()
					delete(active, nodeId)
					mu.Unlock()
					notify()
				}()
				runner.runNode(nodeId)
			}(nodeId, done)
		}
		runner.routeEmissions(modules)
		mu.Lock()
		busy := len(active) > 0
		mu.Unlock()
		if busy {
			<-wake
			stuck = 0
			continue
		}
		if runner.signature() == before {
			stuck++
			if stuck >= maxStuck {
				break
			}
		} else {
			stuck = 0
		}
	}
	afterRow, _ := graphDBRow(runner.kernelDB(), "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=?", runner.options.GraphId)
	blocked := runner.pausedNodes()
	return RunResult{
		Drained:      runner.queuedCount() == 0 && len(blocked) == 0,
		Executions:   int(graphDBInt(afterRow, "n") - beforeExecutions),
		BlockedNodes: blocked,
	}
}

func (runner *GraphRunner) waitActive(mu *sync.Mutex, active map[string]chan struct{}) {
	for {
		mu.Lock()
		var waiter chan struct{}
		for _, done := range active {
			waiter = done
			break
		}
		mu.Unlock()
		if waiter == nil {
			return
		}
		<-waiter
	}
}

func (runner *GraphRunner) runNode(nodeId string) {
	kernel := runner.options.Kernel
	var driver *NodeTurnDriver
	options := NodeExecutorOptions{
		MaxItems: intPointer(1),
		Kernel:   kernel,
		GraphId:  runner.options.GraphId,
		Signal:   runner.options.Signal,
		OpenHost: func(executionId string, revisionVersion int) ExecutorHost {
			nodeHost := runner.options.HostFor(nodeId, revisionVersion)
			turn := NodeTurnDriverOptions{
				Kernel: kernel, GraphId: runner.options.GraphId, NodeId: nodeId, Host: nodeHost,
				Submit: runner.options.Submit,
			}
			if runner.options.InitialContext != nil {
				turn.InitialContext = func() string { return runner.options.InitialContext(nodeId) }
			}
			driver = NewNodeTurnDriver(turn)
			return nodeHost
		},
	}
	if runner.options.SettleWorkspace != nil {
		options.SettleWorkspace = runner.options.SettleWorkspace
	}
	if runner.options.TokenBudget != nil && runner.options.ReserveTokens != nil {
		options.TokenBudget = runner.options.TokenBudget
		options.ReserveTokens = runner.options.ReserveTokens
	}
	if runner.options.Workspace != nil {
		options.Workspace = func() *string { return runner.options.Workspace(nodeId) }
	}
	if runner.options.Artifacts != nil {
		options.Artifacts = runner.options.Artifacts
	}
	executor := NewNodeExecutor(options)
	executor.RunNode(nodeId, func(executionId string, attempt int, injection *TurnInjection, input *QueueRow) TurnReport {
		return driver.Run(executionId, attempt, injection, input)
	})
}

func (runner *GraphRunner) routeEmissions(modules *ModuleRuntime) {
	runner.routeModuleDeliveries(modules)
}

func (runner *GraphRunner) routeModuleDeliveries(modules *ModuleRuntime) {
	kernel := runner.options.Kernel
	graphId := runner.options.GraphId
	pending := graphDBAll(runner.kernelDB(), `SELECT t.id,t.module_id,t.outputs FROM kernel_transition_outbox o
      JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0 ORDER BY t.rowid`, graphId)
	for _, transition := range pending {
		if kernel.Store.Task(graphId).Paused != 0 || runner.options.Signal.Aborted() {
			return
		}
		outputs, _ := kernel.Content.Decode(graphDBString(transition, "outputs")).(map[string]any)
		RouteModuleOutputs(kernel, modules, graphId, graphDBString(transition, "module_id"), ModuleEvaluation{
			TransitionId: graphDBString(transition, "id"), Emitted: true, Outputs: outputs, Reasons: []string{},
		}, 0, true)
	}
	rows := graphDBAll(runner.kernelDB(), `SELECT d.id,d.to_endpoint,d.value,i.module_id FROM kernel_module_inbox i
      JOIN kernel_deliveries d ON d.id=i.delivery_id WHERE i.task_id=? AND i.processed=0 ORDER BY d.seq`, graphId)
	for _, row := range rows {
		if kernel.Store.Task(graphId).Paused != 0 || runner.options.Signal.Aborted() {
			return
		}
		moduleId := graphDBString(row, "module_id")
		if kernel.NodeState(graphId, moduleId).Paused {
			continue
		}
		endpoint := graphDBString(row, "to_endpoint")
		input := endpoint[strings.Index(endpoint, ".")+1:]
		deliveryId := graphDBString(row, "id")
		value := kernel.Content.Decode(graphDBString(row, "value"))
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					runner.recordRefusedDelivery(moduleId, deliveryId, rec)
				}
			}()
			definition := kernel.Revision(graphId, modules.RevisionVersion).Definition.Modules[moduleId]
			var evaluation ModuleEvaluation
			switch definition.Type {
			case "operation":
				evaluation = modules.DeliverOperation(moduleId, input, value, func(env moduleEvalEnv) ModuleEvaluationResult {
					if runner.options.Operation == nil {
						panic(errorString("Host operation broker is unavailable"))
					}
					request := ModuleOperationRequest{
						ModuleId: moduleId, DeliveryId: deliveryId, RevisionVersion: modules.RevisionVersion,
						Operation: definition.Operation, Inputs: env.Inputs, State: env.State,
					}
					if runner.options.Signal != nil {
						request.Signal = runner.options.Signal
					}
					result := runner.options.Operation(request)
					return ModuleEvaluationResult{OK: result.Ok, State: result.State, Outputs: result.Outputs, Diagnostics: result.Diagnostics}
				}, deliveryId)
			case "command":
				evaluation = modules.DeliverCustom(moduleId, input, value, func(env moduleEvalEnv) ModuleEvaluationResult {
					return EvaluateModule(ModuleEvaluationInput{Entry: env.Entry, Inputs: env.Inputs, State: env.State, Trigger: env.Trigger, Limits: env.Limits}, nil)
				}, deliveryId)
			default:
				evaluation = modules.ConsumeDelivery(moduleId, input, value, deliveryId)
			}
			if definition.Type == "operation" {
				runner.recordSettledVerdict(moduleId, deliveryId)
			}
			RouteModuleOutputs(kernel, modules, graphId, moduleId, evaluation, 0, true)
		}()
	}
}

const (
	noVerdictNoExitCode  = "no_exit_code"
	noVerdictWaiting     = "waiting_integration"
	noVerdictInterrupted = "interrupted"
)

const unjudgedEvent = "graph.operation.unjudged"

func (runner *GraphRunner) recordRefusedDelivery(moduleId, deliveryId string, recovered any) {
	kernel := runner.options.Kernel
	reason, brake, isDefect := noVerdictNoExitCode, true, false
	if failure, ok := recovered.(*RuntimeError); ok {
		switch failure.Code {
		case "paused":
			reason, brake = noVerdictWaiting, false
		case "integration_blocked":
			reason = noVerdictWaiting
		case "uncertain_operation":
			reason = noVerdictInterrupted
		case "module_defect", "invalid_definition", "invalid_input":
			isDefect = true
		}
	}
	if isDefect {
		runner.failModule(moduleId, deliveryId, recovered)
		return
	}
	if brake {
		kernel.SetNodeQueuePaused(runner.options.GraphId, moduleId, true)
	}
	operation := kernel.ModuleOperationOfDelivery(deliveryId)
	operationId := ""
	if operation != nil {
		operationId = operation.Id
	}
	runner.recordUnjudged(moduleId, deliveryId, operationId, reason)
	if brake {
		message := panicMessage(recovered)
		kernel.Store.Transaction(func() any {
			WakeForBlockedNode(kernel.Store, runner.options.GraphId, BlockedNodeWake{NodeID: moduleId, Reason: message, IncidentID: deliveryId, HasIncident: true})
			return nil
		})
	}
}

func (runner *GraphRunner) failModule(moduleId, deliveryId string, recovered any) {
	kernel := runner.options.Kernel
	kernel.SetNodeQueuePaused(runner.options.GraphId, moduleId, true)
	reason := panicMessage(recovered)
	kernel.Store.Transaction(func() any {
		kernel.Store.Event(runner.options.GraphId, "graph.module.failed", map[string]any{"moduleId": moduleId, "deliveryId": deliveryId, "reason": reason})
		WakeForBlockedNode(kernel.Store, runner.options.GraphId, BlockedNodeWake{NodeID: moduleId, Reason: reason, IncidentID: deliveryId, HasIncident: true})
		return nil
	})
}

func (runner *GraphRunner) recordSettledVerdict(moduleId, deliveryId string) {
	kernel := runner.options.Kernel
	operation := kernel.ModuleOperationOfDelivery(deliveryId)
	if operation == nil || operation.State != "settled" {
		return
	}
	if !kernelResultHasNoExitCode(kernel, operation.Result) {
		return
	}
	runner.recordUnjudged(moduleId, deliveryId, operation.Id, noVerdictNoExitCode)
}

func kernelResultHasNoExitCode(kernel *KernelStore, result string) bool {
	if result == "" {
		return false
	}
	settled, _ := kernel.Content.Decode(result).(map[string]any)
	outputs, _ := settled["outputs"].(map[string]any)
	for _, value := range outputs {
		published, _ := value.(map[string]any)
		if code, present := published["code"]; present && code == nil {
			return true
		}
	}
	return false
}

func (runner *GraphRunner) recordUnjudged(moduleId, deliveryId, operationId, reason string) {
	seen, _ := graphDBRow(runner.kernelDB(), `SELECT cursor FROM events WHERE task_id=? AND type=?
      AND json_extract(data,'$.deliveryId')=? AND json_extract(data,'$.reasonCode')=?`,
		runner.options.GraphId, unjudgedEvent, deliveryId, reason)
	if seen != nil {
		return
	}
	runner.options.Kernel.Store.Event(runner.options.GraphId, unjudgedEvent, map[string]any{
		"moduleId": moduleId, "deliveryId": deliveryId, "operationId": operationId, "reasonCode": reason,
	})
}

func (runner *GraphRunner) kernelDB() *sql.DB {
	return runner.options.Kernel.Store.Db
}

func intPointer(value int) *int {
	return &value
}
