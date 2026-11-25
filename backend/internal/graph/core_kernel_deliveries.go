package graph

import (
	"strings"
)

func (k *KernelStore) DeliverDirect(taskID, endpoint string, value any) DirectDelivery {
	revision := k.LatestRevision(taskID)
	if revision == nil {
		Raise("invalid_graph", "Graph "+taskID+" has no definition")
	}
	dot := strings.IndexByte(endpoint, '.')
	owner, port := kernelSplitEndpoint(endpoint)
	var ref ProtocolRef
	found := false
	if node, ok := revision.Definition.Nodes[owner]; ok {
		ref, found = node.Inputs[port]
	}
	if !found {
		if module, ok := revision.Definition.Modules[owner]; ok {
			ref, found = module.Inputs[port]
		}
	}
	if dot < 1 || !found {
		Raise("invalid_input", "Unknown input "+endpoint)
	}
	if defect := ValidateProtocolValue(revision.Definition.Protocols[ref.Protocol], value, endpoint); defect != nil && *defect != "" {
		Raise("invalid_input", *defect)
	}
	return k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		requireProjectActive(k.Store, k.Store.Task(taskID).ProjectID)
		if reason := verificationDispatchBlock(k, taskID, owner, k.LatestRevision(taskID).Definition); reason != "" {
			Raise("verification_required", reason)
		}
		id := graphUUID()
		createdAt := NowMillis()
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", taskID)
		seq := g5Int(seqRow["s"]) + 1
		g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, nil, nil, "main", endpoint, k.Content.Encode(value), ref.Protocol, revision.Version, seq, "accepted", createdAt, "direct")
		delivery := DeliveryRow{Id: id, TaskId: taskID, ToEndpoint: endpoint, FromEndpoint: "main", Value: value, Protocol: ref.Protocol, RevisionVersion: revision.Version, Seq: seq, State: "accepted", Source: "direct", CreatedAt: createdAt}
		if _, moduleTarget := revision.Definition.Modules[owner]; moduleTarget {
			g5Exec(k.Db, "INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)", id, taskID, owner)
			k.Store.Event(taskID, "graph.delivery.accepted", map[string]any{"deliveryId": id, "endpoint": endpoint})
			return DirectDelivery{Delivery: delivery}
		}
		queue := k.EnqueueInCurrentTransaction(taskID, QueueInsert{NodeId: owner, Kind: "delivery", Payload: map[string]any{"deliveryId": id, "input": port, "value": value, "protocol": ref.Protocol, "revisionVersion": revision.Version}})
		return DirectDelivery{Delivery: delivery, Queue: &queue}
	}).(DirectDelivery)
}

func (k *KernelStore) deliveryFrom(row map[string]any) DeliveryRow {
	var submission *string
	if row["submission_id"] != nil {
		text := g5Str(row["submission_id"])
		submission = &text
	}
	var edge *string
	if row["edge_id"] != nil {
		text := g5Str(row["edge_id"])
		edge = &text
	}
	source := "submission"
	if g5Str(row["source"]) == "direct" || g5Str(row["source"]) == "module" {
		source = g5Str(row["source"])
	}
	return DeliveryRow{
		Id: g5Str(row["id"]), TaskId: g5Str(row["task_id"]), SubmissionId: submission, EdgeId: edge,
		FromEndpoint: g5Str(row["from_endpoint"]), ToEndpoint: g5Str(row["to_endpoint"]), Value: k.Content.Decode(g5Str(row["value"])),
		Protocol: g5Str(row["protocol"]), RevisionVersion: int(g5Int(row["revision_version"])), Seq: g5Int(row["seq"]),
		State: "accepted", Source: source, CreatedAt: g5Int(row["created_at"]),
	}
}

func (k *KernelStore) RecordCompletionDelivery(taskID, commitSHA string) {
	g5Exec(k.Db, "INSERT INTO kernel_completion_delivery(task_id,commit_sha,created_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET commit_sha=excluded.commit_sha,created_at=excluded.created_at",
		taskID, commitSHA, NowMillis())
}

func (k *KernelStore) MarkDeliveryProcessed(deliveryID string) {
	g5Exec(k.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", deliveryID)
}

func (k *KernelStore) MarkGraphDeliveriesProcessed(taskID string) {
	g5Exec(k.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE task_id=?", taskID)
}

func (k *KernelStore) DeliveryEdges(taskID string) []DeliveryEdge {
	rows := g5Query(k.Db, "SELECT from_endpoint,to_endpoint FROM kernel_deliveries WHERE task_id=?", taskID)
	out := make([]DeliveryEdge, 0, len(rows))
	for _, row := range rows {
		out = append(out, DeliveryEdge{From: g5Str(row["from_endpoint"]), To: g5Str(row["to_endpoint"])})
	}
	return out
}

func (k *KernelStore) DeliveriesForEdge(taskID, edgeID string) []DeliveryRow {
	rows := g5Query(k.Db, "SELECT * FROM kernel_deliveries WHERE task_id=? AND edge_id=? ORDER BY seq DESC", taskID, edgeID)
	out := make([]DeliveryRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, k.deliveryFrom(row))
	}
	return out
}

func (k *KernelStore) DeliveriesFor(executionID string) []DeliveryRow {
	rows := g5Query(k.Db, `SELECT d.* FROM kernel_deliveries d JOIN kernel_submissions s ON s.id = d.submission_id WHERE s.execution_id = ? ORDER BY d.seq`, executionID)
	out := make([]DeliveryRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, k.deliveryFrom(row))
	}
	return out
}

func (k *KernelStore) RecordModuleDelivery(taskID, moduleID, edgeID, fromEndpoint, toEndpoint, protocol string, value any, revisionVersion int) DeliveryRow {
	_ = moduleID
	return k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		id := graphUUID()
		createdAt := NowMillis()
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", taskID)
		seq := g5Int(seqRow["s"]) + 1
		g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, nil, edgeID, fromEndpoint, toEndpoint, k.Content.Encode(value), protocol, revisionVersion, seq, "accepted", createdAt, "module")
		edge := edgeID
		return DeliveryRow{Id: id, TaskId: taskID, EdgeId: &edge, FromEndpoint: fromEndpoint, ToEndpoint: toEndpoint, Value: value, Protocol: protocol, RevisionVersion: revisionVersion, Seq: seq, State: "accepted", Source: "module", CreatedAt: createdAt}
	}).(DeliveryRow)
}

func (k *KernelStore) publishGraphOutputs(taskID, endpoint string, value any, sourceID string, revision *RevisionRow) {
	for _, name := range sortedKeys(revision.Definition.Outputs) {
		output := revision.Definition.Outputs[name]
		if output.From != endpoint {
			continue
		}
		resultID := graphUUID()
		changes, _ := g5Exec(k.Db, "INSERT OR IGNORE INTO kernel_graph_results(id,task_id,output_name,source_id,value,protocol,revision_version,created_at) VALUES(?,?,?,?,?,?,?,?)", resultID, taskID, name, sourceID, k.Content.Encode(value), output.Protocol, revision.Version, NowMillis())
		if changes == 0 {
			continue
		}
		data := map[string]any{"graphId": taskID, "output": name, "sourceId": sourceID, "resultId": resultID, "revision": revision.Version}
		WakeMaster(k.Store, WakeIntent{TaskID: taskID, Kind: "graph_output", DedupeKey: taskID + ":" + name + ":" + sourceID, Data: data, HasData: true})
		k.Store.Event(taskID, "graph.output", map[string]any{"output": name, "sourceId": sourceID, "resultId": resultID, "revision": revision.Version})
		if revision.Definition.Completion != nil && revision.Definition.Completion.On == name {
			g5Exec(k.Db, "INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1", taskID)
			k.Store.CompleteTaskPhase(taskID)
		}
	}
}

func (k *KernelStore) BroadcastModule(taskID, moduleID string, outputs map[string]any, transitionID string) []DeliveryRow {
	return k.Store.Transaction(func(tx *TaskStore) any {
		k := k.scoped(tx)
		if transitionID != "" {
			if row, ok := g5One(k.Db, "SELECT routed FROM kernel_transition_outbox WHERE transition_id=?", transitionID); ok && g5Int(row["routed"]) == 1 {
				return []DeliveryRow{}
			}
		}
		k.assertOutputsOpen(taskID)
		revision := k.LatestRevision(taskID)
		module, moduleOK := revision.Definition.Modules[moduleID]
		if revision == nil || !moduleOK {
			Raise("invalid_output", "Unknown module "+moduleID)
		}
		if revision == nil {
			Raise("invalid_definition", "Unknown module "+moduleID)
		}
		type target struct {
			edgeID, endpoint, protocol, owner, port string
			value                                   any
			module                                  bool
		}
		targets := []target{}
		for _, name := range sortedKeys(outputs) {
			value := outputs[name]
			output, outputOK := module.Outputs[name]
			if !outputOK {
				Raise("invalid_output", "Unknown output "+moduleID+"."+name)
			}
			protocol, protocolOK := revision.Definition.Protocols[output.Protocol]
			if !protocolOK {
				Raise("invalid_definition", "Unknown protocol "+output.Protocol)
			}
			if defect := ValidateProtocolValue(protocol, value, moduleID+"."+name); defect != nil && *defect != "" {
				Raise("invalid_output", *defect)
			}
			for _, edgeID := range sortedKeys(revision.Definition.Edges) {
				edge := revision.Definition.Edges[edgeID]
				if !edge.Enabled || edge.From != moduleID+"."+name {
					continue
				}
				owner, port := kernelSplitEndpoint(edge.To)
				targetModule, isModule := revision.Definition.Modules[owner]
				var input ProtocolRef
				found := false
				if isModule {
					input, found = targetModule.Inputs[port]
				} else if node, ok := revision.Definition.Nodes[owner]; ok {
					input, found = node.Inputs[port]
				}
				targetProtocol, protocolFound := revision.Definition.Protocols[input.Protocol]
				if !found || !protocolFound {
					Raise("invalid_definition", "Unknown input "+edge.To)
				}
				if defect := ValidateProtocolValue(targetProtocol, value, edge.To); defect != nil && *defect != "" {
					Raise("invalid_output", *defect)
				}
				targets = append(targets, target{edgeID: edgeID, endpoint: edge.To, protocol: input.Protocol, value: value, owner: owner, port: port, module: isModule})
			}
		}
		sourceID := transitionID
		if sourceID == "" {
			sourceID = graphUUID()
		}
		for _, name := range sortedKeys(outputs) {
			k.publishGraphOutputs(taskID, moduleID+"."+name, outputs[name], sourceID, revision)
		}
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", taskID)
		seq := g5Int(seqRow["s"])
		deliveries := []DeliveryRow{}
		for _, item := range targets {
			id := graphUUID()
			createdAt := NowMillis()
			seq++
			edge := revision.Definition.Edges[item.edgeID]
			g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, nil, item.edgeID, edge.From, item.endpoint, k.Content.Encode(item.value), item.protocol, revision.Version, seq, "accepted", createdAt, "module")
			if item.module {
				g5Exec(k.Db, "INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)", id, taskID, item.owner)
			} else {
				k.EnqueueDelivery(taskID, item.owner, map[string]any{"deliveryId": id, "input": item.port, "value": item.value})
			}
			edgeID := item.edgeID
			deliveries = append(deliveries, DeliveryRow{Id: id, TaskId: taskID, EdgeId: &edgeID, FromEndpoint: edge.From, ToEndpoint: item.endpoint, Value: item.value, Protocol: item.protocol, RevisionVersion: revision.Version, Seq: seq, State: "accepted", Source: "module", CreatedAt: createdAt})
		}
		if transitionID != "" {
			g5Exec(k.Db, "UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id=?", transitionID)
		}
		return deliveries
	}).([]DeliveryRow)
}
