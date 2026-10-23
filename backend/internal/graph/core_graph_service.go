package graph

import (
	"fmt"
)

// GraphManagement is the main-agent management contract. Every target remains
// in the owner's conversation.
type GraphManagement interface {
	GraphCreate(input GraphCreateInput) any
	GraphPatch(input GraphPatchInput) any
	GraphInspect(input GraphInspectInput) any
	GraphControl(input GraphControlInput) any
	GraphSend(input GraphSendInput) any
	// HarnessCompare reads the behavioral contrast of the candidates of one
	// task. It belongs to the graph facts it reads, so it lives here.
	HarnessCompare(input HarnessCompareInput) HarnessComparison
	// HarnessExperience reads the lessons earlier tasks adopted per domain.
	HarnessExperience(input HarnessExperienceInput) HarnessExperienceResult
	// HarnessDecision records the adopted candidate and the lesson it taught.
	HarnessDecision(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult
	// HarnessFriction records friction the project met but has not solved.
	HarnessFriction(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult
	// HarnessProbe runs one task under several harnesses and contrasts them.
	HarnessProbe(input HarnessProbeInput) HarnessProbeResult
	// HarnessEvidence reads the evidence of the caller's own run: the
	// trajectory, the tool failures, the blocked work and the usage.
	HarnessEvidence(input HarnessEvidenceInput) HarnessEvidenceResult
}

// GraphCreateInput creates an independently owned graph.
type GraphCreateInput struct {
	Definition   any
	TargetBranch *string
	RequestId    *string
}

// GraphPatchInput publishes a new revision of a graph.
type GraphPatchInput struct {
	GraphId      string
	BaseRevision int
	Changes      PatchChange
}

// GraphInspectInput reads a graph's facts.
type GraphInspectInput struct {
	GraphId      string
	Query        *string
	Id           *string
	DeliveryId   *string
	TransitionId *string
	After        *int
	Limit        *int
}

// GraphControlInput drives a graph's execution controls.
type GraphControlInput struct {
	GraphId     string
	Action      string
	NodeId      *string
	ModuleId    *string
	Seq         *int
	OperationId *string
	CallId      *string
	Usage       *TokenUsage
}

// GraphSendInput delivers a public input or a chat message.
type GraphSendInput struct {
	GraphId string
	NodeId  *string
	Input   *string
	Value   any
	Text    *string
}

// GraphCreateResult is the graph a create returns.
type GraphCreateResult struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   int             `json:"revision"`
	RequestId  string          `json:"requestId"`
	Replayed   bool            `json:"replayed"`
}

// GraphCreateBlocked is the result of a create whose Git preparation failed.
type GraphCreateBlocked struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   int             `json:"revision"`
	RequestId  string          `json:"requestId"`
	State      string          `json:"state"`
	Reason     string          `json:"reason"`
}

// graphManagementService is the GraphManagement bound to one owner task.
type graphManagementService struct {
	kernel      *KernelStore
	ownerTaskId string
	prepare     func(graphId string, branch string)
	artifacts   *ArtifactWorkspace
}

// NewGraphManagement binds the management surface to one owner task.
// The TypeScript export was graphManagement; the interface kept the
// GraphManagement name, so the factory follows the constructor spelling.
func NewGraphManagement(kernel *KernelStore, ownerTaskId string, prepare func(graphId string, branch string), artifacts *ArtifactWorkspace) GraphManagement {
	return &graphManagementService{kernel: kernel, ownerTaskId: ownerTaskId, prepare: prepare, artifacts: artifacts}
}

func (service *graphManagementService) owner() TaskRow {
	return service.kernel.Store.Task(service.ownerTaskId)
}

func (service *graphManagementService) runtime(graphId string) *GraphRuntime {
	target := service.kernel.Store.Task(graphId)
	binding := kernelRow(service.kernel.Db, "SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?", graphId)
	owner := service.owner()
	ownerConversation := ""
	if owner.ConversationID != nil {
		ownerConversation = *owner.ConversationID
	}
	targetConversation := ""
	if target.ConversationID != nil {
		targetConversation = *target.ConversationID
	}
	if graphId != service.ownerTaskId && kernelString(binding["owner_task_id"]) != service.ownerTaskId &&
		(ownerConversation == "" || targetConversation != ownerConversation) {
		Raise("permission", "Graph belongs to another conversation")
	}
	if service.kernel.LatestRevision(graphId) == nil {
		Raise("invalid_graph", "Target has no graph definition")
	}
	return NewGraphRuntime(service.kernel, graphId, service.artifacts)
}

// GraphCreate creates an independently owned graph from a complete definition.
func (service *graphManagementService) GraphCreate(input GraphCreateInput) any {
	definition := ParseGraphDefinition(input.Definition)
	requestId := graphUUID()
	if input.RequestId != nil {
		requestId = *input.RequestId
	}
	var targetBranchValue any
	if input.TargetBranch != nil {
		targetBranchValue = *input.TargetBranch
	}
	hasTargetBranch := input.TargetBranch != nil && *input.TargetBranch != ""
	content := CanonicalJSON(map[string]any{"definition": definition, "targetBranch": targetBranchValue})
	previous := kernelRow(service.kernel.Db, "SELECT graph_id,content,state FROM kernel_create_requests WHERE owner_task_id=? AND request_id=?", service.ownerTaskId, requestId)
	if previous != nil && kernelString(previous["content"]) != content {
		Raise("invalid_input", "Creation requestId was already used with a different definition")
	}
	graphId := graphUUID()
	if previous != nil {
		graphId = kernelString(previous["graph_id"])
	}
	parent := service.owner()
	created := GraphCreateResult{}
	if previous != nil {
		latest := service.kernel.LatestRevision(graphId)
		if latest == nil {
			Raise("invalid_graph", "Target has no graph definition")
		}
		created = GraphCreateResult{GraphId: graphId, Definition: latest.Definition, Revision: latest.Version}
	} else {
		created = service.kernel.Store.Transaction(func() any {
			var conversationId any
			if parent.ConversationID != nil {
				conversationId = *parent.ConversationID
			}
			kernelExec(service.kernel.Db, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase,target_branch) VALUES(?,?,?,?,1,0,?,?,?)",
				graphId, parent.ProjectID, conversationId, definition.Name, NowMillis(), "running", targetBranchValue)
			if hasTargetBranch {
				kernelExec(service.kernel.Db, "UPDATE tasks SET paused=1 WHERE id=?", graphId)
			}
			createState := "ready"
			if hasTargetBranch {
				createState = "preparing"
			}
			kernelExec(service.kernel.Db, "INSERT INTO kernel_create_requests(owner_task_id,request_id,graph_id,content,state) VALUES(?,?,?,?,?)",
				service.ownerTaskId, requestId, graphId, content, createState)
			kernelExec(service.kernel.Db, "INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)", graphId, service.ownerTaskId)
			revision := service.kernel.InsertRevision(graphId, definition, "create")
			for _, id := range sortedKeys(definition.Nodes) {
				service.kernel.AdmitNode(graphId, revision.Version, id, AdmitNodeInput{InstanceId: graphUUID()})
			}
			for _, id := range sortedKeys(definition.Modules) {
				module := definition.Modules[id]
				service.kernel.AdmitModule(graphId, revision.Version, id, AdmitModuleInput{ModuleType: module.Type, Trigger: module.Trigger})
			}
			service.kernel.Store.Event(graphId, "graph.created", map[string]any{"ownerTaskId": service.ownerTaskId, "revision": revision.Version})
			return GraphCreateResult{GraphId: graphId, Definition: definition, Revision: revision.Version}
		}).(GraphCreateResult)
	}
	if hasTargetBranch && (previous == nil || kernelString(previous["state"]) != "ready") {
		reason := ""
		failed := false
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					failed = true
					reason = graphServiceErrorMessage(recovered)
				}
			}()
			if service.prepare == nil {
				Raise("invalid_input", "Git preparation is unavailable")
			}
			service.prepare(graphId, *input.TargetBranch)
			service.kernel.Store.Transaction(func() any {
				kernelExec(service.kernel.Db, "UPDATE kernel_create_requests SET state='ready',error=NULL WHERE owner_task_id=? AND request_id=?", service.ownerTaskId, requestId)
				kernelExec(service.kernel.Db, "UPDATE tasks SET paused=0,phase='running' WHERE id=?", graphId)
				return nil
			})
		}()
		if failed {
			service.kernel.Store.Transaction(func() any {
				kernelExec(service.kernel.Db, "UPDATE kernel_create_requests SET state='failed',error=? WHERE owner_task_id=? AND request_id=?", reason, service.ownerTaskId, requestId)
				kernelExec(service.kernel.Db, "UPDATE tasks SET paused=1,phase='blocked' WHERE id=?", graphId)
				service.kernel.Store.Event(graphId, "graph.preparation.failed", map[string]any{"reason": reason, "requestId": requestId})
				return nil
			})
			return GraphCreateBlocked{
				GraphId:    created.GraphId,
				Definition: created.Definition,
				Revision:   created.Revision,
				RequestId:  requestId,
				State:      "blocked",
				Reason:     reason,
			}
		}
	}
	return GraphCreateResult{
		GraphId:    created.GraphId,
		Definition: created.Definition,
		Revision:   created.Revision,
		RequestId:  requestId,
		Replayed:   previous != nil,
	}
}

// GraphPatch publishes a new revision of a graph.
func (service *graphManagementService) GraphPatch(input GraphPatchInput) any {
	return service.runtime(input.GraphId).Patch(input.BaseRevision, input.Changes)
}

// GraphInspect reads a graph's summary, revision, nodes, history, or evidence.
func (service *graphManagementService) GraphInspect(input GraphInspectInput) any {
	graph := service.runtime(input.GraphId)
	query := ""
	if input.Query != nil {
		query = *input.Query
	}
	historyQuery := HistoryQuery{}
	if input.Id != nil && *input.Id != "" {
		nodeId := *input.Id
		historyQuery.NodeId = &nodeId
	}
	historyQuery.After = input.After
	historyQuery.Limit = input.Limit
	switch query {
	case "queue":
		return service.kernel.QueueHistory(input.GraphId, historyQuery)
	case "executions":
		return service.kernel.ExecutionHistory(input.GraphId, historyQuery)
	case "acceptance":
		return GraphAcceptance(service.kernel, input.GraphId, service.artifacts)
	case "provider_calls":
		if input.Id != nil && *input.Id != "" {
			return service.kernel.ProviderCalls(input.GraphId, *input.Id)
		}
		return service.kernel.ProviderCalls(input.GraphId)
	case "operations":
		rows := kernelRows(service.kernel.Db, "SELECT id,module_id,delivery_id,revision_version,request,state,result,error,worker_active,record_digest,created_at,started_at,ended_at FROM kernel_module_operations WHERE task_id=? ORDER BY created_at", input.GraphId)
		operations := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			operation := map[string]any{}
			for key, value := range row {
				operation[key] = value
			}
			operation["request"] = service.kernel.Content.Decode(kernelString(row["request"]))
			if row["result"] != nil && kernelString(row["result"]) != "" {
				operation["result"] = service.kernel.Content.Decode(kernelString(row["result"]))
			} else {
				operation["result"] = nil
			}
			operations = append(operations, operation)
		}
		return operations
	case "edge_delivery":
		if input.Id == nil || *input.Id == "" || input.DeliveryId == nil || *input.DeliveryId == "" {
			Raise("invalid_query", "edge_delivery requires edge id and deliveryId")
		}
		deliveries := ExplainEdge(service.kernel, input.GraphId, *input.Id, nil, EdgeHistoryQuery{
			DeliveryID: input.DeliveryId,
			FullValue:  true,
			Limit:      1,
		}).Deliveries
		if len(deliveries) == 0 {
			return nil
		}
		return deliveries[0]
	case "edge":
		return ExplainEdge(service.kernel, input.GraphId, graphServiceId(input.Id), nil, EdgeHistoryQuery{
			Before: graphServiceOptionalNumber(input.After),
			Limit:  graphServiceOptionalNumber(input.Limit),
		})
	case "module_values":
		includeTransitions := false
		return ExplainModule(service.kernel, input.GraphId, graphServiceId(input.Id), ModuleHistoryQuery{
			FullValues:         true,
			IncludeTransitions: &includeTransitions,
		})
	case "module_transition":
		if input.Id == nil || *input.Id == "" || input.TransitionId == nil || *input.TransitionId == "" {
			Raise("invalid_query", "module_transition requires module id and transitionId")
		}
		transitions := ExplainModule(service.kernel, input.GraphId, *input.Id, ModuleHistoryQuery{
			TransitionID: input.TransitionId,
			Limit:        1,
		}).Transitions
		if len(transitions) == 0 {
			return nil
		}
		return transitions[0]
	case "module":
		return ExplainModule(service.kernel, input.GraphId, graphServiceId(input.Id), ModuleHistoryQuery{
			After: graphServiceOptionalNumber(input.After),
			Limit: graphServiceOptionalNumber(input.Limit),
		})
	case "results":
		rows := kernelRows(service.kernel.Db, "SELECT * FROM kernel_graph_results WHERE task_id=? ORDER BY rowid", input.GraphId)
		results := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			result := map[string]any{}
			for key, value := range row {
				result[key] = value
			}
			result["value"] = service.kernel.Content.Decode(kernelString(row["value"]))
			results = append(results, result)
		}
		return results
	}
	if query != "" && query != "summary" && query != "revision" && query != "nodes" {
		Raise("invalid_query", "Unknown graph query "+query)
	}
	kind := "summary"
	if query == "revision" {
		kind = "revision"
	} else if query == "nodes" {
		kind = "nodes"
	}
	return graph.Inspect(kind)
}

// GraphControl drives a graph's execution controls.
func (service *graphManagementService) GraphControl(input GraphControlInput) any {
	graph := service.runtime(input.GraphId)
	phase := GraphPhase("")
	if state := graph.State(); state != nil {
		phase = state.Phase
	}
	switch input.Action {
	case "pause", "resume", "reopen", "retry", "skip", "cancel":
		if phase == "completed" || phase == "stopping" || phase == "stopped" {
			Raise("invalid_graph", "Ended graph cannot change its execution controls")
		}
	}
	switch input.Action {
	case "relayout":
		kernelExec(service.kernel.Db, "DELETE FROM kernel_graph_layouts WHERE task_id=?", input.GraphId)
		service.kernel.Store.Event(input.GraphId, "graph.layout_reset", map[string]any{})
		return map[string]any{"state": "layout_reset"}
	case "cancel_operation":
		operationId := ""
		if input.OperationId != nil {
			operationId = *input.OperationId
		}
		owned := kernelRow(service.kernel.Db, "SELECT id FROM kernel_module_operations WHERE task_id=? AND id=?", input.GraphId, operationId)
		if owned != nil {
			ReconcileOperationResources(service.kernel, operationId)
		}
		operation := kernelRow(service.kernel.Db, "SELECT delivery_id,module_id,state,worker_active FROM kernel_module_operations WHERE task_id=? AND id=?", input.GraphId, operationId)
		if operation == nil {
			Raise("invalid_operation", "Only an interrupted or failed operation can be cancelled; stop active work first")
		}
		state := kernelString(operation["state"])
		if state != "uncertain" && state != "failed" && state != "cancelled" {
			Raise("invalid_operation", "Only an interrupted or failed operation can be cancelled; stop active work first")
		}
		if kernelInt(operation["worker_active"]) != 0 {
			Raise("invalid_operation", "Operation still holds execution resources; verify termination before cancelling")
		}
		if state == "cancelled" {
			return graph.State()
		}
		deliveryId := kernelString(operation["delivery_id"])
		moduleId := kernelString(operation["module_id"])
		service.kernel.ModuleTransaction(func() any {
			kernelExec(service.kernel.Db, "UPDATE kernel_module_operations SET state='cancelled' WHERE id=?", operationId)
			kernelExec(service.kernel.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", deliveryId)
			service.kernel.SetNodeQueuePaused(input.GraphId, moduleId, false)
			kernelExec(service.kernel.Db, "UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked' AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)", input.GraphId, input.GraphId)
			service.kernel.Store.Event(input.GraphId, "graph.operation.cancelled", map[string]any{
				"operationId": operationId,
				"deliveryId":  deliveryId,
				"moduleId":    moduleId,
			})
			return nil
		})
		return graph.State()
	case "reconcile_usage":
		if input.CallId == nil || *input.CallId == "" || input.Usage == nil {
			Raise("invalid_input", "reconcile_usage requires callId and usage")
		}
		return ReconcileKernelUsage(service.kernel, input.GraphId, *input.CallId, *input.Usage)
	case "complete":
		return graph.Complete()
	case "withdraw_complete":
		return graph.WithdrawComplete()
	case "stop":
		return graph.Stop()
	case "reopen":
		if input.ModuleId == nil || *input.ModuleId == "" {
			Raise("invalid_input", "reopen requires moduleId")
		}
		latest := service.kernel.LatestRevision(input.GraphId)
		if latest == nil {
			Raise("invalid_graph", "Target has no graph definition")
		}
		return NewModuleRuntime(service.kernel, input.GraphId, latest.Version).ReopenAfterPending(*input.ModuleId)
	case "pause", "resume":
		if input.NodeId != nil && input.ModuleId != nil {
			Raise("invalid_input", "Pause/resume accepts either nodeId or moduleId")
		}
		target := ""
		hasTarget := false
		if input.ModuleId != nil {
			target = *input.ModuleId
			hasTarget = true
		} else if input.NodeId != nil {
			target = *input.NodeId
			hasTarget = true
		}
		paused := input.Action == "pause"
		if hasTarget {
			latest := service.kernel.LatestRevision(input.GraphId)
			if latest == nil {
				Raise("invalid_graph", "Target has no graph definition")
			}
			known := false
			if input.ModuleId != nil {
				_, known = latest.Definition.Modules[target]
			} else {
				_, known = latest.Definition.Nodes[target]
			}
			if !known {
				Raise("invalid_input", "Pause/resume requires a target in the current graph definition")
			}
			service.kernel.SetNodeQueuePaused(input.GraphId, target, paused)
			if !paused {
				kernelExec(service.kernel.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'", input.GraphId, target)
			}
		} else {
			flag := 0
			if paused {
				flag = 1
			}
			kernelExec(service.kernel.Db, "UPDATE tasks SET paused=? WHERE id=?", flag, input.GraphId)
		}
		targetNode := ""
		if hasTarget {
			targetNode = target
		}
		SetNativePause(service.kernel.Store, input.GraphId, paused, targetNode, 0)
		return graph.State()
	case "retry", "skip", "cancel":
		if input.Seq == nil {
			Raise("invalid_input", input.Action+" requires queue seq")
		}
		seq := *input.Seq
		row := kernelRow(service.kernel.Db, "SELECT node_id,state FROM kernel_queue WHERE task_id=? AND seq=?", input.GraphId, seq)
		if row == nil {
			Raise("invalid_queue", "Queue item is absent, still executing, or already settled")
		}
		state := kernelString(row["state"])
		if state == "claimed" || state == "done" {
			Raise("invalid_queue", "Queue item is absent, still executing, or already settled")
		}
		nodeId := kernelString(row["node_id"])
		// Stable node ids are literal text, never a wildcard expression.
		base := "exec-" + input.GraphId + "-" + nodeId + "-" + itoa(seq)
		submitted := kernelRow(service.kernel.Db, "SELECT submission_id FROM kernel_executions WHERE task_id=? AND node_id=? AND submission_id IS NOT NULL AND (id=? OR instr(id,?)=1)",
			input.GraphId, nodeId, base, base+"-")
		if input.Action == "retry" && submitted != nil {
			Raise("invalid_queue", "Submitted work cannot be sent again")
		}
		service.kernel.Store.Transaction(func() any {
			queueState := "done"
			generation := 0
			if input.Action == "retry" {
				queueState = "queued"
				generation = 1
			}
			kernelExec(service.kernel.Db, "UPDATE kernel_queue SET state=?,reason=?,generation=generation+? WHERE task_id=? AND seq=?",
				queueState, input.Action, generation, input.GraphId, seq)
			kernelExec(service.kernel.Db, "UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?", input.GraphId, nodeId)
			SetNativePause(service.kernel.Store, input.GraphId, false, nodeId, 0)
			kernelExec(service.kernel.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status IN ('blocked','failed')", input.GraphId, nodeId)
			kernelExec(service.kernel.Db, "UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked' AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)", input.GraphId, input.GraphId)
			service.kernel.Store.Event(input.GraphId, "graph.queue."+input.Action, map[string]any{"seq": seq, "nodeId": nodeId})
			return nil
		})
		return graph.State()
	}
	Raise("invalid_input", "Unknown graph control action "+input.Action)
	return nil
}

// GraphSend delivers a public input or a chat message to a graph.
func (service *graphManagementService) GraphSend(input GraphSendInput) any {
	graph := service.runtime(input.GraphId)
	if input.Input != nil {
		endpoint := ""
		if input.NodeId != nil && *input.NodeId != "" {
			endpoint = *input.NodeId + "." + *input.Input
		} else if latest := service.kernel.LatestRevision(input.GraphId); latest != nil {
			if declared, ok := latest.Definition.Inputs[*input.Input]; ok {
				endpoint = declared.To
			}
		}
		if endpoint == "" {
			Raise("invalid_input", "Unknown public input "+*input.Input)
		}
		return graph.DeliverEndpoint(endpoint, input.Value)
	}
	if input.NodeId == nil || *input.NodeId == "" {
		Raise("invalid_input", "Chat requires nodeId")
	}
	text := ""
	if input.Text != nil {
		text = *input.Text
	}
	return graph.Chat(*input.NodeId, text, false)
}

func graphServiceId(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func graphServiceOptionalNumber(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func graphServiceErrorMessage(recovered any) string {
	if err, ok := recovered.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(recovered)
}
