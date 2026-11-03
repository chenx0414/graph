package graph

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
	case "limitations":
		return service.kernel.AcceptanceLimitations(input.GraphId)
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
