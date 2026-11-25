package graph

import (
	"encoding/json"
	"strings"
)

func (k *KernelStore) PublishRevision(taskID string, definition GraphDefinition, reason string, version ...int) *RevisionRow {
	if strings.TrimSpace(reason) == "" {
		Raise("invalid_definition", "A revision reason is required")
	}
	parsed := ParseGraphDefinition(definition)
	return k.tx(func() any { return k.InsertRevision(taskID, parsed, reason, version...) }).(*RevisionRow)
}

func (k *KernelStore) InsertRevision(taskID string, definition GraphDefinition, reason string, version ...int) *RevisionRow {
	if strings.TrimSpace(reason) == "" {
		Raise("invalid_definition", "A revision reason is required")
	}
	next := 0
	if len(version) > 0 {
		next = version[0]
	} else {
		row, _ := g5One(k.Db, "SELECT COALESCE(MAX(version),0) AS v FROM kernel_revisions WHERE task_id=?", taskID)
		next = int(g5Int(row["v"])) + 1
	}
	if _, exists := g5One(k.Db, "SELECT 1 FROM kernel_revisions WHERE task_id=? AND version=?", taskID, next); exists {
		Raise("invalid_definition", "Revision "+kernelItoa(int64(next))+" already exists and is immutable")
	}
	createdAt := NowMillis()
	g5Exec(k.Db, "INSERT INTO kernel_revisions(task_id,version,definition,reason,created_at) VALUES(?,?,?,?,?)", taskID, next, CanonicalJSON(definition), reason, createdAt)
	return &RevisionRow{TaskId: taskID, Version: next, Definition: definition, Reason: reason, CreatedAt: createdAt}
}

func (k *KernelStore) Revision(taskID string, version int) *RevisionRow {
	row, ok := g5One(k.Db, "SELECT definition,reason,created_at FROM kernel_revisions WHERE task_id=? AND version=?", taskID, version)
	if !ok {
		return nil
	}
	var definition GraphDefinition
	if err := json.Unmarshal([]byte(g5Str(row["definition"])), &definition); err != nil {
		panic(err)
	}
	return &RevisionRow{TaskId: taskID, Version: version, Definition: definition, Reason: g5Str(row["reason"]), CreatedAt: g5Int(row["created_at"])}
}

func (k *KernelStore) LatestRevision(taskID string) *RevisionRow {
	row, ok := g5One(k.Db, "SELECT version FROM kernel_revisions WHERE task_id=? ORDER BY version DESC LIMIT 1", taskID)
	if !ok {
		return nil
	}
	return k.Revision(taskID, int(g5Int(row["version"])))
}

func (k *KernelStore) ModuleTransaction(action func() any) any {
	if k.moduleTransactionActive {
		return action()
	}
	return k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		k.moduleTransactionActive = true
		defer func() { k.moduleTransactionActive = false }()
		return action()
	})
}

func (input AdmitNodeInput) instance() string {
	if input.InstanceId != "" {
		return input.InstanceId
	}
	return input.InstanceID
}

func (k *KernelStore) AdmitNode(taskID string, revisionVersion int, nodeID string, input AdmitNodeInput) {
	revision := k.Revision(taskID, revisionVersion)
	if revision == nil {
		Raise("invalid_definition", "Unknown revision "+kernelItoa(int64(revisionVersion)))
	}
	node, ok := revision.Definition.Nodes[nodeID]
	if !ok {
		Raise("invalid_definition", "Revision "+kernelItoa(int64(revisionVersion))+" has no node "+nodeID)
	}
	kind := input.Kind
	if kind == "" {
		kind = "agent"
	}
	g5Exec(k.Db, "INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status) VALUES(?,?,?,?,?,?,?)", taskID, revisionVersion, nodeID, input.instance(), kind, CanonicalJSON(node), "idle")
	RegisterNodeAgent(k.Store, taskID, nodeID, "", "")
	if _, paused := g5One(k.Db, "SELECT 1 FROM kernel_nodes WHERE task_id=? AND graph_paused=1", taskID); paused {
		k.SetNativePause(taskID, true, "", 0)
	}
}

func (k *KernelStore) AdmitModule(taskID string, revisionVersion int, moduleID string, input AdmitModuleInput) {
	revision := k.Revision(taskID, revisionVersion)
	if revision == nil {
		Raise("invalid_definition", "Unknown revision "+kernelItoa(int64(revisionVersion)))
	}
	if _, ok := revision.Definition.Modules[moduleID]; !ok {
		Raise("invalid_definition", "Revision "+kernelItoa(int64(revisionVersion))+" has no module "+moduleID)
	}
	g5Exec(k.Db, "INSERT INTO kernel_modules(task_id,revision_version,module_id,module_type,trigger) VALUES(?,?,?,?,?)", taskID, revisionVersion, moduleID, input.ModuleType, input.Trigger)
}

func (k *KernelStore) StartExecution(taskID string, input StartExecutionRequest) ExecutionRow {
	return k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		existing := k.Execution(input.ExecutionId)
		if existing != nil {
			if existing.TaskId != taskID || existing.NodeId != input.NodeId || (existing.SubmissionId != nil && !hasNodeCompletion(k.Store.Path, input.ExecutionId)) || existing.State != "blocked" {
				Raise("invalid_execution", "Execution cannot be started again")
			}
			g5Exec(k.Db, "UPDATE kernel_executions SET state='running',ended_at=NULL,run_since=?,waiting_since=NULL,waiting_slot=0 WHERE id=?", NowMillis(), input.ExecutionId)
		} else {
			startedAt := NowMillis()
			var budget any
			if input.TokenBudget != nil {
				raw, err := json.Marshal(input.TokenBudget)
				if err != nil {
					panic(err)
				}
				budget = string(raw)
			}
			g5Exec(k.Db, "INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at,token_budget,run_ms,waiting_ms,run_since) VALUES(?,?,?,?,0,?,?,?,0,0,?)", input.ExecutionId, taskID, input.NodeId, input.RevisionVersion, "running", startedAt, budget, startedAt)
		}
		execution := k.Execution(input.ExecutionId)
		g5Exec(k.Db, "UPDATE kernel_nodes SET status='running' WHERE task_id=? AND node_id=?", taskID, input.NodeId)
		k.Store.Event(taskID, "graph.execution.started", map[string]any{"executionId": input.ExecutionId, "nodeId": input.NodeId, "revisionVersion": execution.RevisionVersion})
		return *execution
	}).(ExecutionRow)
}

func (k *KernelStore) BlockQueued(taskID string, seq int64) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='queued' WHERE task_id=? AND seq=? AND state='claimed'", taskID, seq)
}

func (k *KernelStore) SetExecutionState(executionID, state string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET state=? WHERE id=?", state, executionID)
}

func (k *KernelStore) FinishExecution(executionID, state string) {
	finish := func() {
		now := NowMillis()
		k.CloseExecutionTiming(executionID, now)
		g5Exec(k.Db, "UPDATE kernel_executions SET state=?, ended_at=? WHERE id=?", state, now, executionID)
	}
	if k.Store.IsTransaction() {
		finish()
		return
	}
	k.Store.Transaction(func(tx *TaskStore) any { finish(); return nil })
}

func (k *KernelStore) Execution(executionID string) *ExecutionRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_executions WHERE id=?", executionID)
	if !ok {
		return nil
	}
	return kernelExecutionRow(row)
}

func (k *KernelStore) RunningExecution(taskID, nodeID string) *ExecutionRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", taskID, nodeID)
	if !ok {
		return nil
	}
	return kernelExecutionRow(row)
}

func kernelExecutionRow(row map[string]any) *ExecutionRow {
	var submission *string
	if row["submission_id"] != nil {
		text := g5Str(row["submission_id"])
		submission = &text
	}
	var ended *int64
	if row["ended_at"] != nil {
		value := g5Int(row["ended_at"])
		ended = &value
	}
	var budget *TokenBudget
	if row["token_budget"] != nil && g5Str(row["token_budget"]) != "" {
		parsed := &TokenBudget{}
		if err := json.Unmarshal([]byte(g5Str(row["token_budget"])), parsed); err != nil {
			panic(err)
		}
		budget = parsed
	}
	gap := []string{}
	if row["pending_gap"] != nil && g5Str(row["pending_gap"]) != "" {
		if err := json.Unmarshal([]byte(g5Str(row["pending_gap"])), &gap); err != nil {
			panic(err)
		}
	}
	return &ExecutionRow{
		Id: g5Str(row["id"]), TaskId: g5Str(row["task_id"]), NodeId: g5Str(row["node_id"]), RevisionVersion: int(g5Int(row["revision_version"])),
		Attempt: int(g5Int(row["attempt"])), RetriesUsed: int(g5Int(row["retries_used"])), ResubmitsUsed: int(g5Int(row["resubmits_used"])),
		PendingGap: gap, TokenBudget: budget, State: g5Str(row["state"]), SubmissionId: submission,
		MissingRequired: g5Int(row["missing_required"]) == 1, StartedAt: g5Int(row["started_at"]), EndedAt: ended,
	}
}

func (k *KernelStore) NoteExecutionContinuation(executionID, kind string, missing []string) {
	if missing == nil {
		missing = []string{}
	}
	column := "resubmits_used"
	if kind == "retry" {
		column = "retries_used"
	}
	raw, err := json.Marshal(missing)
	if err != nil {
		panic(err)
	}
	g5Exec(k.Db, "UPDATE kernel_executions SET "+column+"="+column+"+1,pending_gap=? WHERE id=?", string(raw), executionID)
}

func (k *KernelStore) NoteExecutionAttempt(executionID string) int {
	g5Exec(k.Db, "UPDATE kernel_executions SET attempt=attempt+1 WHERE id=?", executionID)
	return k.Execution(executionID).Attempt
}

func (k *KernelStore) assertOutputsOpen(taskID string) {
	phase := k.Store.Task(taskID).Phase
	if GraphPhase(phase).Closed() {
		Raise("invalid_graph", "Graph "+taskID+" is "+phase+"; new outputs are closed")
	}
}

func (k *KernelStore) Submit(executionID string, request SubmitRequest) SubmitReceipt {
	return k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		execution := k.Execution(executionID)
		if execution == nil {
			refuseMessage("Unknown execution " + executionID)
		}
		existing, ok := g5One(k.Db, "SELECT id, content_digest FROM kernel_submissions WHERE execution_id=?", executionID)
		if ok {
			return k.replayOrRefuse(*execution, request, g5Str(existing["id"]), g5Str(existing["content_digest"]))
		}
		if execution.State != "running" {
			refuseSubmit([]SubmitDefect{{
				Code: "execution_not_running", Path: execution.Id,
				Expected: "a running execution", Got: execution.State,
			}}, nil)
		}
		k.assertOutputsOpen(execution.TaskId)
		revision := k.Revision(execution.TaskId, execution.RevisionVersion)
		node, nodeOK := revision.Definition.Nodes[execution.NodeId]
		if !nodeOK {
			refuseMessage("Execution node " + execution.NodeId + " is not in revision " + kernelItoa(int64(revision.Version)))
		}
		if request.Outputs == nil {
			refuseMessage("outputs must be a named object")
		}
		for _, name := range sortedKeys(request.Outputs) {
			output := request.Outputs[name]
			declared, declaredOK := node.Outputs[name]
			if !declaredOK {
				refuseSubmit([]SubmitDefect{{
					Code: "unknown_output", Path: name,
					Expected: "a declared output of this node", Got: name,
				}}, nil)
			}
			if !output.Enable {
				continue
			}
			spec, specOK := revision.Definition.Protocols[declared.Protocol]
			if !specOK {
				refuseMessage("Output " + name + " references undeclared protocol " + declared.Protocol)
			}
			if defect := ValidateProtocolValue(spec, output.Value, execution.NodeId+"."+name); defect != nil && *defect != "" {
				refuseSubmit([]SubmitDefect{{
					Code: "output_protocol_mismatch", Path: name,
					Expected: declared.Protocol + ": " + *defect, Got: "the value you sent",
				}}, nil)
			}
		}
		queue, queued := g5One(k.Db, "SELECT kind FROM kernel_queue WHERE task_id=? AND node_id=? AND state='claimed' LIMIT 1", execution.TaskId, execution.NodeId)
		chat := queued && g5Str(queue["kind"]) == "chat"
		required := node.Submission.Required
		anyOf := node.Submission.RequiredAnyOf
		if chat {
			required = nil
			anyOf = nil
		}
		if len(anyOf) > 0 {
			enabledAny := false
			for _, name := range anyOf {
				if output, exists := request.Outputs[name]; exists && output.Enable {
					enabledAny = true
				}
			}
			if !enabledAny {
				refuseMissingOutputs(anyOf)
			}
		}
		missing := []string{}
		for _, name := range required {
			output, exists := request.Outputs[name]
			if !exists || !output.Enable {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			refuseMissingOutputs(missing)
		}
		connections := k.LatestRevision(execution.TaskId)
		type target struct {
			edgeID, to, protocol string
			value                any
		}
		targets := []target{}
		enabled := []string{}
		for _, name := range sortedKeys(request.Outputs) {
			if request.Outputs[name].Enable {
				enabled = append(enabled, name)
			}
		}
		for _, name := range enabled {
			output := request.Outputs[name]
			for _, edgeID := range sortedKeys(connections.Definition.Edges) {
				edge := connections.Definition.Edges[edgeID]
				if edge.From != execution.NodeId+"."+name || !edge.Enabled {
					continue
				}
				owner, port := kernelSplitEndpoint(edge.To)
				targetNode, nodeTarget := connections.Definition.Nodes[owner]
				targetModule, moduleTarget := connections.Definition.Modules[owner]
				var ref ProtocolRef
				found := false
				if nodeTarget {
					ref, found = targetNode.Inputs[port]
				}
				if !found && moduleTarget {
					ref, found = targetModule.Inputs[port]
				}
				if !found {
					refuseMessage("Edge " + edgeID + " targets unknown input " + edge.To)
				}
				if spec, specOK := connections.Definition.Protocols[ref.Protocol]; specOK {
					if defect := ValidateProtocolValue(spec, output.Value, edge.To); defect != nil && *defect != "" {
						refuseSubmit([]SubmitDefect{{
							Code: "target_protocol_mismatch", Path: edge.To,
							Expected: ref.Protocol + ": " + *defect, Got: "the value the edge would carry",
						}}, nil)
					}
				}
				targets = append(targets, target{edgeID: edgeID, to: edge.To, value: output.Value, protocol: ref.Protocol})
			}
		}
		for _, name := range enabled {
			k.publishGraphOutputs(execution.TaskId, execution.NodeId+"."+name, request.Outputs[name].Value, request.SubmissionId, connections)
		}
		digest := ContentDigest(CanonicalJSON(map[string]any{"outputs": request.Outputs}))
		createdAt := NowMillis()
		g5Exec(k.Db, "INSERT INTO kernel_submissions(id,task_id,execution_id,content_digest,outputs,created_at) VALUES(?,?,?,?,?,?)", request.SubmissionId, execution.TaskId, executionID, digest, k.Content.Encode(request.Outputs), createdAt)
		deliveries := []DeliveryRow{}
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", execution.TaskId)
		nextSeq := g5Int(seqRow["s"])
		for index, item := range targets {
			id := graphUUID()
			seq := nextSeq + int64(index) + 1
			edge := connections.Definition.Edges[item.edgeID]
			g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, execution.TaskId, request.SubmissionId, item.edgeID, edge.From, item.to, k.Content.Encode(item.value), item.protocol, connections.Version, seq, "accepted", createdAt)
			owner, port := kernelSplitEndpoint(item.to)
			if _, moduleTarget := connections.Definition.Modules[owner]; moduleTarget {
				g5Exec(k.Db, "INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)", id, execution.TaskId, owner)
			} else {
				g5Exec(k.Db, "INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)", execution.TaskId, owner, "delivery", k.Content.Encode(map[string]any{"deliveryId": id, "input": port, "value": item.value}), createdAt)
			}
			submission := request.SubmissionId
			edgeID := item.edgeID
			deliveries = append(deliveries, DeliveryRow{
				Id: id, TaskId: execution.TaskId, SubmissionId: &submission, EdgeId: &edgeID, FromEndpoint: edge.From, ToEndpoint: item.to,
				Value: item.value, Protocol: item.protocol, RevisionVersion: connections.Version, Seq: seq, State: "accepted", Source: "submission", CreatedAt: createdAt,
			})
		}
		g5Exec(k.Db, "UPDATE kernel_executions SET submission_id=?, missing_required=0 WHERE id=?", request.SubmissionId, executionID)
		_, landed := g5One(k.Db, "SELECT 1 FROM kernel_graph_results WHERE task_id=? AND source_id=? LIMIT 1", execution.TaskId, request.SubmissionId)
		return SubmitReceipt{SubmissionId: request.SubmissionId, Replayed: false, Deliveries: deliveries, NoRecipients: len(deliveries) == 0 && !landed}
	}).(SubmitReceipt)
}

func (k *KernelStore) replayOrRefuse(execution ExecutionRow, request SubmitRequest, id, stored string) SubmitReceipt {
	digest := CanonicalJSON(map[string]any{"outputs": request.Outputs})
	if id == request.SubmissionId && (stored == digest || stored == ContentDigest(digest)) {
		deliveries := k.DeliveriesFor(execution.Id)
		_, landed := g5One(k.Db, "SELECT 1 FROM kernel_graph_results WHERE task_id=? AND source_id=? LIMIT 1", execution.TaskId, request.SubmissionId)
		return SubmitReceipt{SubmissionId: request.SubmissionId, Replayed: true, Deliveries: deliveries, NoRecipients: len(deliveries) == 0 && !landed}
	}
	refuseSubmit([]SubmitDefect{{
		Code: "already_submitted", Path: execution.Id,
		Expected: "one valid submission per execution", Got: "a second, different submission",
	}}, nil)
	return SubmitReceipt{}
}

func (k *KernelStore) BlockFailedExecution(executionID string) {
	g5Exec(k.Db, "UPDATE kernel_executions SET state='blocked' WHERE id=? AND state='failed'", executionID)
}
