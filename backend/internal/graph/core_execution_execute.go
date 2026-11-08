package graph

import (
	"encoding/json"
)

func (e *Execution) execute(node ExecutionNodeRow) bool {
	graphDatabaseMu.Lock()
	if e.stopping || (e.dispatchAllowed != nil && !e.dispatchAllowed()) || e.store.Task(node.TaskId).Paused != 0 {
		graphDatabaseMu.Unlock()
		return false
	}
	status := kernelRow(e.store.Db, "SELECT status FROM nodes WHERE task_id=? AND id=?", node.TaskId, node.Id)
	if status == nil || kernelString(status["status"]) != "pending" {
		graphDatabaseMu.Unlock()
		return false
	}
	if e.store.Task(node.TaskId).Phase == "chatting" {
		conversation := ConversationForTask(e.store, node.TaskId)
		if conversation == nil || conversation.ArchivedAt != nil || conversation.Role == ConversationHistory {
			graphDatabaseMu.Unlock()
			return false
		}
	}
	node = e.refreshDefinition(node)
	spec := e.nodeSpec(node)
	if spec.Role == nil || *spec.Role != "master" || spec.Kind != "agent" {
		graphDatabaseMu.Unlock()
		Raise("invalid_node", "External main executor only accepts the main agent")
	}
	adapter := e.adapterFor(spec.Action)
	if adapter == nil || adapter.Kind != spec.Kind {
		e.store.Transaction(func() any {
			e.block(node, "adapter_error", map[string]any{"reason": "No " + spec.Kind + " adapter for " + spec.Action}, nil)
			return nil
		})
		graphDatabaseMu.Unlock()
		return false
	}
	if spec.Kind == "agent" && e.models != nil && node.InstanceId != nil {
		selected := PickModel(PickModelInput{Spec: spec, Models: e.models})
		if selected == nil {
			e.store.Transaction(func() any {
				e.block(node, "model_unavailable", map[string]any{"requested": spec.Model}, nil)
				return nil
			})
			graphDatabaseMu.Unlock()
			return false
		}
		var definitionVersion any
		if spec.DefinitionVersion != nil {
			definitionVersion = *spec.DefinitionVersion
		}
		e.store.SetInstanceModelAndDefinition(*node.InstanceId, selected.Id, instanceDefinitionVersion(definitionVersion))
		identity := selected.Id
		if selected.ModelId != "" {
			identity = selected.ModelId
		}
		RecordModelUse(e.store, *node.InstanceId, identity)
		if spec.Model != nil && *spec.Model != selected.Id {
			e.store.Event(node.TaskId, "model.switched", map[string]any{
				"nodeId":     node.Id,
				"from":       *spec.Model,
				"to":         selected.Id,
				"instanceId": *node.InstanceId,
			})
		}
	}
	baseGrants := []string{}
	projectRow := kernelRow(e.store.Db, "SELECT grants FROM projects WHERE id=?", e.store.Task(node.TaskId).ProjectID)
	if projectRow != nil {
		var stored []string
		if err := json.Unmarshal([]byte(kernelString(projectRow["grants"])), &stored); err != nil {
			panic(err)
		}
		baseGrants = stored
	}
	grants := append([]string{}, baseGrants...)
	for _, row := range kernelRows(e.store.Db, "SELECT grant FROM task_grants WHERE task_id=?", node.TaskId) {
		grant := kernelString(row["grant"])
		if !containsString(grants, grant) {
			grants = append(grants, grant)
		}
	}
	requiredGrant := adapter.Grant
	if requiredGrant != nil && *requiredGrant != "" && !containsString(grants, *requiredGrant) {
		e.store.Transaction(func() any {
			InsertQuestion(e.store, QuestionInput{
				TaskId:     node.TaskId,
				NodeId:     node.Id,
				Kind:       "permission",
				Data:       map[string]any{"grant": *requiredGrant},
				AutoAnswer: &QuestionAutoAnswer{Answer: Answer{Type: "grant", Grant: *requiredGrant}},
			})
			return nil
		})
		grants = append(grants, *requiredGrant)
	}
	slot := "program"
	if spec.Kind == "agent" {
		slot = "agent"
	}
	if OccupiedSlots(e.store, slot) >= int64(ExecutionLimit(slot)) {
		graphDatabaseMu.Unlock()
		return false
	}
	reservation := int64(0)
	if spec.Kind == "agent" {
		if adapter.ReserveTokens == nil {
			graphDatabaseMu.Unlock()
			Raise("invalid_adapter", "A bounded token reservation is required")
		}
		reservation = int64(*adapter.ReserveTokens)
	}
	if reservation < 0 {
		graphDatabaseMu.Unlock()
		Raise("invalid_adapter", "A bounded token reservation is required")
	}
	var workspace *string
	if e.git != nil {
		workspace = e.git.Workspace(node.TaskId, node.InstanceId, node.Id, spec.Kind, spec.Action)
	}
	operation, admitted := e.admit(node, spec, reservation, workspace, grants)
	if !admitted {
		graphDatabaseMu.Unlock()
		return false
	}
	graphDatabaseMu.Unlock()

	dispatch, prepareFailure := e.prepareDispatch(adapter, operation)
	if prepareFailure != "" {
		graphDatabaseMu.Lock()
		e.lifecycle.MarkPreparationFailed(operation.Id, prepareFailure)
		graphDatabaseMu.Unlock()
		return false
	}

	graphDatabaseMu.Lock()
	deferredContinuation := operation.Context.RsiContinuation != nil && (e.store.Task(node.TaskId).Paused != 0 ||
		conversationArchived(e.store, node.TaskId))
	if e.stopping || deferredContinuation || (e.dispatchAllowed != nil && !e.dispatchAllowed()) || e.store.Task(node.TaskId).Paused != 0 {
		e.lifecycle.CancelBeforeDispatch(operation.Id, "Cancelled before dispatch")
		graphDatabaseMu.Unlock()
		return false
	}
	e.lifecycle.Dispatch(operation)
	graphDatabaseMu.Unlock()

	result, dispatchFailure := e.runDispatch(dispatch)
	graphDatabaseMu.Lock()
	if dispatchFailure == nil {
		reportFailure := e.reportResult(operation, result)
		graphDatabaseMu.Unlock()
		if reportFailure != nil {
			panic(reportFailure)
		}
		if e.autoWake {
			e.Kick()
		}
		return true
	}
	refusal, isRefusal := dispatchFailure.(*RuntimeError)
	if isRefusal && e.lifecycle.HandleDispatchRefusal(operation, refusal, reservation) {
		graphDatabaseMu.Unlock()
		return false
	}
	e.lifecycle.MarkUncertain(operation, dispatchFailureText(dispatchFailure), false)
	graphDatabaseMu.Unlock()
	return true
}

func conversationArchived(store *TaskStore, taskId string) bool {
	conversation := ConversationForTask(store, taskId)
	return conversation != nil && conversation.ArchivedAt != nil
}

func (e *Execution) prepareDispatch(adapter *ActionAdapter, operation Operation) (func() OperationResult, string) {
	if adapter.Prepare == nil {
		return nil, "prepare must return a dispatch callback"
	}
	var dispatch func() OperationResult
	failure := func() (failure any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				failure = recovered
			}
		}()
		dispatch = adapter.Prepare(operation)
		return nil
	}()
	if failure != nil {
		return nil, dispatchFailureText(failure)
	}
	if dispatch == nil {
		return nil, "prepare must return a dispatch callback"
	}
	return dispatch, ""
}

func (e *Execution) runDispatch(dispatch func() OperationResult) (result OperationResult, failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
		}
	}()
	return dispatch(), nil
}

func dispatchFailureText(failure any) string {
	switch typed := failure.(type) {
	case error:
		return typed.Error()
	case string:
		return typed
	default:
		return jsonStringify(failure)
	}
}

func (e *Execution) reportResult(operation Operation, result OperationResult) (failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
		}
	}()
	e.lifecycle.Report(operation.Id, operation.Generation, result)
	return nil
}
