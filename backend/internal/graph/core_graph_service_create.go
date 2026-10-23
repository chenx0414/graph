package graph

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
			service.kernel.Store.CreateSubgraphTask(graphId, parent.ProjectID, conversationId, definition.Name, NowMillis(), targetBranchValue)
			if hasTargetBranch {
				service.kernel.Store.PauseTask(graphId)
			}
			createState := "ready"
			if hasTargetBranch {
				createState = "preparing"
			}
			kernelExec(service.kernel.Db, "INSERT INTO kernel_create_requests(owner_task_id,request_id,graph_id,content,state) VALUES(?,?,?,?,?)",
				service.ownerTaskId, requestId, graphId, content, createState)
			kernelExec(service.kernel.Db, "INSERT INTO kernel_graph_owners(task_id,owner_task_id) VALUES(?,?)", graphId, service.ownerTaskId)
			revision := service.kernel.InsertRevision(graphId, definition, "create")
			// TODO(port): Go maps have no insertion order; the node ids are sorted.
			for _, id := range portKeys(definition.Nodes) {
				service.kernel.AdmitNode(graphId, revision.Version, id, AdmitNodeInput{InstanceId: graphUUID()})
			}
			for _, id := range portKeys(definition.Modules) {
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
				service.kernel.Store.ResumeTask(graphId)
				return nil
			})
		}()
		if failed {
			service.kernel.Store.Transaction(func() any {
				kernelExec(service.kernel.Db, "UPDATE kernel_create_requests SET state='failed',error=? WHERE owner_task_id=? AND request_id=?", reason, service.ownerTaskId, requestId)
				service.kernel.Store.BlockTask(graphId)
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
