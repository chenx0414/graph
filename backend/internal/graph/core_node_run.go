package graph

import (
	"encoding/json"
)

// NodeRun reads the read-only node detail: definition identity, session
// reference, entries and per-operation timing where credential waiting is
// separated from run time.
func NodeRun(store *TaskStore, taskId, nodeId string, query NodeEntryQuery) NodeRunView {
	task := store.Task(taskId)
	node := kernelRow(store.Db, "SELECT id,spec,instance_id,status,activation_id,output_version,stall_count FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if node == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	var spec nodeRunSpec
	if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err != nil {
		panic(err)
	}
	capabilities, capabilityDigest := nodeRunCapabilities(store, taskId, nodeId, spec, task.Phase)
	var instance *NodeRunInstance
	if instanceId := kernelString(node["instance_id"]); instanceId != "" {
		row := kernelRow(store.Db, "SELECT id,model,definition_version,used,budget,unlimited,models_used FROM instances WHERE id=?", instanceId)
		if row != nil {
			view := &NodeRunInstance{
				ID: kernelString(row["id"]), Used: kernelInt(row["used"]),
				Unlimited: kernelInt(row["unlimited"]) != 0,
			}
			if row["model"] != nil {
				value := kernelString(row["model"])
				view.Model = &value
			}
			if row["definition_version"] != nil {
				value := kernelString(row["definition_version"])
				view.DefinitionVersion = &value
			}
			if !view.Unlimited {
				budget := kernelInt(row["budget"])
				view.Budget = &budget
			}
			modelsUsed := []string{}
			if raw := kernelString(row["models_used"]); raw != "" {
				var parsed []string
				if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
					panic(err)
				}
				modelsUsed = parsed
			}
			view.ModelsUsed = modelsUsed
			instance = view
		}
	}
	var session *NodeRunSession
	if instanceId := kernelString(node["instance_id"]); instanceId != "" {
		row := kernelRow(store.Db, "SELECT session_id,session_file FROM node_sessions WHERE instance_id=?", instanceId)
		if row != nil {
			view := &NodeRunSession{SessionID: kernelString(row["session_id"])}
			if row["session_file"] != nil {
				value := kernelString(row["session_file"])
				view.SessionFile = &value
			}
			session = view
		}
	}
	operations := NodeOperationRuns(store, taskId, nodeId)
	if operations == nil {
		operations = []OperationRun{}
	}
	invocations := []NodeRunInvocation{}
	for _, row := range kernelRows(store.Db, `SELECT i.id,i.model,i.usage,i.cost,i.purpose FROM invocations i JOIN operations o ON o.id=i.operation_id
    WHERE o.task_id=? AND o.node_id=? ORDER BY i.rowid`, taskId, nodeId) {
		var usage *TokenUsage
		if raw := kernelString(row["usage"]); raw != "" {
			parsed := &TokenUsage{}
			if err := json.Unmarshal([]byte(raw), parsed); err != nil {
				panic(err)
			}
			usage = parsed
		}
		var cost Json
		if raw := kernelString(row["cost"]); raw != "" {
			cost = parseJSON(raw)
		}
		invocations = append(invocations, NodeRunInvocation{
			ID: kernelString(row["id"]), Model: kernelString(row["model"]), Purpose: kernelString(row["purpose"]),
			Usage: usage, UsageSource: UsageSourceOf(usage), Cost: cost,
		})
	}
	questions := []NodeRunQuestion{}
	for _, row := range kernelRows(store.Db, "SELECT id,kind,status,data FROM questions WHERE task_id=? AND node_id=? ORDER BY rowid", taskId, nodeId) {
		questions = append(questions, NodeRunQuestion{
			ID: kernelString(row["id"]), Kind: kernelString(row["kind"]), Status: kernelString(row["status"]),
			Data: parseJSON(kernelString(row["data"])),
		})
	}
	evidence := []NodeRunEvidence{}
	for _, row := range kernelRows(store.Db, "SELECT acceptance_id,valid,commit_sha FROM evidence WHERE task_id=? AND node_id=? ORDER BY rowid", taskId, nodeId) {
		item := NodeRunEvidence{AcceptanceID: kernelString(row["acceptance_id"]), Valid: kernelInt(row["valid"]) != 0}
		if row["commit_sha"] != nil {
			value := kernelString(row["commit_sha"])
			item.CommitSha = &value
		}
		evidence = append(evidence, item)
	}
	page := ListNodeEntries(store, taskId, nodeId, query)
	usageFacts := nodeRunCapabilityUsage(store, taskId, nodeId, capabilities)
	// Time segments come from authoritative state timestamps, never from the
	// message span. "Still running" is a property of the current lifecycle:
	// a terminal node is never in progress because of a historical attempt.
	nodeTerminal := map[string]bool{"succeeded": true, "skipped": true, "retired": true, "failed": true}[kernelString(node["status"])]
	active := 0
	for _, operation := range operations {
		if operation.WorkerActive || operation.State == "dispatched" || operation.State == "running" {
			active++
		}
	}
	inProgress := !nodeTerminal && active > 0
	settled := []OperationRun{}
	for _, operation := range operations {
		if operation.DispatchedAt != nil && operation.SettledAt != nil {
			settled = append(settled, operation)
		}
	}
	ledger := NodeTimeLedgerOf(store, taskId, nodeId)
	timing := NodeRunTiming{InProgress: inProgress}
	if len(settled) > 0 {
		maxSettled := int64(0)
		minDispatched := int64(0)
		runMs := int64(0)
		for index, operation := range settled {
			if index == 0 || *operation.SettledAt > maxSettled {
				maxSettled = *operation.SettledAt
			}
			if index == 0 || *operation.DispatchedAt < minDispatched {
				minDispatched = *operation.DispatchedAt
			}
			if operation.RunMs != nil {
				runMs += *operation.RunMs
			}
		}
		total := maxSettled - minDispatched
		if total < 0 {
			total = 0
		}
		timing.TotalMs = &total
		timing.RunMs = &runMs
	}
	for _, operation := range operations {
		timing.WaitingMs += operation.WaitingMs
	}
	// Recorded pause / user-wait segments; a historical node without ledger
	// facts stays "未记录" instead of being inferred from message times.
	timing.PauseMs = ledger.PauseMs
	timing.UserWaitMs = ledger.UserWaitMs
	nodeView := NodeRunNode{
		ID: kernelString(node["id"]), Kind: spec.Kind, Action: spec.Action, Role: spec.Role,
		Status:        kernelString(node["status"]),
		OutputVersion: kernelInt(node["output_version"]), StallCount: kernelInt(node["stall_count"]),
	}
	if node["activation_id"] != nil {
		value := kernelString(node["activation_id"])
		nodeView.ActivationID = &value
	}
	if spec.DefinitionVersion != nil && *spec.DefinitionVersion != "" {
		value := *spec.DefinitionVersion
		nodeView.DefinitionVersion = &value
	}
	if len(spec.Input) > 0 {
		nodeView.Input = spec.Input
	}
	return NodeRunView{
		TaskID: taskId, NodeID: nodeId, Context: ContextView(store, taskId, nodeId),
		Capabilities: capabilities, CapabilityUsage: usageFacts, CapabilityDigest: capabilityDigest,
		Node: nodeView, Instance: instance, Session: session, Operations: operations,
		Invocations: invocations, Questions: questions, Evidence: evidence, Timing: timing,
		Entries: page.Entries, EntryCount: page.EntryCount, HasOlder: page.HasOlder, HasNewer: page.HasNewer,
		Phase: task.Phase,
	}
}
