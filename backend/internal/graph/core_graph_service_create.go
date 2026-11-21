package graph

func (service *graphManagementService) GraphCreate(input GraphCreateInput) any {
	definition := ParseGraphDefinition(input.Definition)
	requestId := graphUUID()
	if input.RequestId != nil {
		requestId = *input.RequestId
	}
	unlock := lockWorkGraph("graph-create:"+service.ownerTaskId, requestId)
	defer unlock()
	if conversation := ConversationForTask(service.kernel.Store, service.ownerTaskId); conversation != nil && conversation.Role == ConversationHistory {
		Raise("permission", "Historical conversations cannot create graph work")
	}
	var targetBranchValue any
	if input.TargetBranch != nil {
		targetBranchValue = *input.TargetBranch
	}
	hasTargetBranch := input.TargetBranch != nil && *input.TargetBranch != ""
	if hasStagedVerification(definition) {
		reservation := kernelRow(service.kernel.Db, "SELECT proposal,target_branch FROM work_graphs WHERE owner_task_id=? AND kernel_request_id=?", service.ownerTaskId, requestId)
		if reservation == nil || !hasTargetBranch || kernelString(reservation["target_branch"]) != *input.TargetBranch {
			Raise("permission", "Verification-driven implementation requires a confirmed work draft with a Git target")
		}
		proposal, _ := g5JSON(kernelString(reservation["proposal"])).(map[string]any)
		if CanonicalJSON(ParseGraphDefinition(proposal["definition"])) != CanonicalJSON(definition) {
			Raise("permission", "Verification-driven implementation must use the confirmed work draft")
		}
	}
	content := CanonicalJSON(map[string]any{"definition": definition, "targetBranch": targetBranchValue})
	previous := service.kernel.FindCreateRequest(service.ownerTaskId, requestId)
	if previous != nil && previous.Content != content {
		Raise("invalid_input", "Creation requestId was already used with a different definition")
	}
	graphId := graphUUID()
	if previous != nil {
		graphId = previous.GraphID
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
			if conversation := ConversationForTask(service.kernel.Store, service.ownerTaskId); conversation != nil && conversation.Role == ConversationHistory {
				Raise("permission", "Historical conversations cannot create graph work")
			}
			requireProjectActive(service.kernel.Store, parent.ProjectID)
			var conversationId any
			if parent.ConversationID != nil {
				conversationId = *parent.ConversationID
			}
			service.kernel.Store.CreateSubgraphTask(graphId, parent.ProjectID, conversationId, definition.Name, NowMillis(), targetBranchValue)
			if hasTargetBranch {
				service.kernel.Store.StartGraphPreparation(graphId)
			}
			createState := "ready"
			if hasTargetBranch {
				createState = "preparing"
			}
			service.kernel.RecordCreateRequest(service.ownerTaskId, requestId, graphId, content, createState)
			service.kernel.RecordGraphOwner(graphId, service.ownerTaskId)
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
	if hasTargetBranch && (previous == nil || previous.State != "ready") {
		reason := service.prepareGraph(graphId, service.ownerTaskId, requestId, *input.TargetBranch, parent.ProjectID, false)
		if reason != "" {
			return GraphCreateBlocked{GraphId: created.GraphId, Definition: created.Definition, Revision: created.Revision, RequestId: requestId, State: "blocked", Reason: reason}
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
