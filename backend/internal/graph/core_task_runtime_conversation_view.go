package graph

import (
	"encoding/json"
)

// messageQueryOf narrows a node-entry query down to the message window the
// conversation transcript understands. The entry selector has no meaning for
// messages, so it is dropped, exactly like the TypeScript source did.
func messageQueryOf(query NodeEntryQuery) MessageQuery {
	converted := MessageQuery{}
	if query.After != nil {
		after := int(*query.After)
		converted.After = &after
	}
	if query.Before != nil {
		before := int(*query.Before)
		converted.Before = &before
	}
	if query.Limit != nil {
		limit := int(*query.Limit)
		converted.Limit = &limit
	}
	return converted
}

// View reads the full projection of one conversation.
func (conversations *TaskRuntimeConversations) View(conversationId string, query NodeEntryQuery) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	anchor := runtime.store.Task(conversation.AnchorTaskId)
	master := kernelRow(runtime.store.Db, "SELECT n.status,i.used,i.budget,i.unlimited,COALESCE(i.model,json_extract(n.spec,'$.model')) AS model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'", conversation.AnchorTaskId)
	accepted := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT proposal_version,task_id,target_branch,accepted_at,draft_revision FROM conversation_acceptances WHERE conversation_id=? ORDER BY accepted_at", conversationId) {
		accepted = append(accepted, map[string]any{
			"proposalVersion": kernelInt(row["proposal_version"]),
			"taskId":          kernelString(row["task_id"]),
			"targetBranch":    kernelString(row["target_branch"]),
			"acceptedAt":      kernelInt(row["accepted_at"]),
			"draftRevision":   row["draft_revision"],
		})
	}
	proposal := any(nil)
	if anchor.LatestProposal > 0 {
		proposal = taskRuntimeConversationProposal(runtime.store, anchor.ID, int(anchor.LatestProposal), int(anchor.RequirementVersion), false)
	}
	proposalRows := taskRuntimeProposalRows(runtime.store, anchor.ID)
	proposalHistory := []map[string]any{}
	archivedProposals := []map[string]any{}
	for _, row := range proposalRows {
		if row.DeletedAt != nil {
			continue
		}
		entry := map[string]any{
			"version":            row.Version,
			"requirementVersion": row.RequirementVersion,
			"stale":              row.RequirementVersion != int(anchor.RequirementVersion),
			"draftRevision":      row.DraftRevision,
			"draftDigest":        ContentDigest(row.Spec),
		}
		if row.DraftDigest != nil {
			entry["draftDigest"] = *row.DraftDigest
		}
		if row.ArchivedAt != nil {
			archivedProposals = append(archivedProposals, entry)
			continue
		}
		proposalHistory = append(proposalHistory, entry)
	}
	anchorQuestions := []map[string]any{}
	questionNow := NowMillis()
	questionRows := kernelRows(runtime.store.Db, "SELECT id,task_id,node_id,operation_id,kind,status,data,answer,owner,asked_at FROM questions WHERE task_id=? AND (route_stage IS NULL OR route_stage!='user') ORDER BY rowid", conversation.AnchorTaskId)
	if conversation.Role == ConversationGlobal {
		questionRows = append(questionRows, kernelRows(runtime.store.Db, "SELECT id,task_id,node_id,operation_id,kind,status,data,answer,owner,asked_at FROM questions WHERE route_stage='user' AND status='open' ORDER BY rowid")...)
	}
	for _, row := range questionRows {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		var answer any
		if row["answer"] != nil {
			if err := json.Unmarshal([]byte(kernelString(row["answer"])), &answer); err != nil {
				panic(err)
			}
		}
		anchorQuestions = append(anchorQuestions, AddQuestionWaitFacts(map[string]any{
			"id":          kernelString(row["id"]),
			"nodeId":      kernelString(row["node_id"]),
			"operationId": row["operation_id"],
			"kind":        kernelString(row["kind"]),
			"status":      kernelString(row["status"]),
			"owner":       kernelString(row["owner"]),
			"data":        data,
			"answer":      answer,
			"taskId":      kernelString(row["task_id"]),
		}, row["asked_at"], questionNow))
	}
	tasks := []map[string]any{}
	taskCosts := []CostSummary{}
	taskUsed := int64(0)
	taskBudget := int64(0)
	taskUnlimited := false
	unknownUsagePending := false
	for _, row := range kernelRows(runtime.store.Db, `SELECT t.id,t.request,t.phase,t.paused,t.target_branch,t.accepted_proposal,t.integration_sha,
 (SELECT MIN(timestamp) FROM events WHERE task_id=t.id) AS createdAt FROM tasks t
 LEFT JOIN kernel_graph_owners g ON g.task_id=t.id LEFT JOIN tasks owner ON owner.id=g.owner_task_id
 WHERE (COALESCE(owner.conversation_id,t.conversation_id)=? OR
   (t.conversation_id=? AND EXISTS (SELECT 1 FROM conversations source WHERE source.id=? AND source.role='history')))
 AND t.phase!='chatting' ORDER BY t.created_seq`, conversationId, conversationId, conversationId) {
		taskId := kernelString(row["id"])
		openQuestions := []map[string]any{}
		internalProblems := 0
		for _, question := range kernelRows(runtime.store.Db, "SELECT id,node_id,kind,status,data,owner,asked_at FROM questions WHERE task_id=? ORDER BY rowid", taskId) {
			if kernelString(question["status"]) != "open" {
				continue
			}
			if kernelString(question["kind"]) == "unknown_usage" {
				unknownUsagePending = true
			}
			if kernelString(question["owner"]) == "main" {
				internalProblems++
				continue
			}
			if kernelString(question["owner"]) != "user" {
				continue
			}
			var data any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			openQuestions = append(openQuestions, AddQuestionWaitFacts(map[string]any{
				"id":     kernelString(question["id"]),
				"nodeId": kernelString(question["node_id"]),
				"kind":   kernelString(question["kind"]),
				"data":   data,
			}, question["asked_at"], questionNow))
		}
		nodes := []any{}
		if runtime.kernel.LatestRevision(taskId) == nil {
			for _, node := range kernelRows(runtime.store.Db, "SELECT n.id,n.spec,n.status,n.stall_count,n.output_version,i.used,i.budget,i.unlimited,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid", taskId) {
				var spec NodeSpec
				if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err != nil {
					panic(err)
				}
				var role any
				if spec.Role != nil {
					role = *spec.Role
				}
				unlimited := kernelInt(node["unlimited"]) != 0
				var budget any
				if !unlimited {
					budget = node["budget"]
				}
				taskUsed += kernelInt(node["used"])
				if unlimited {
					taskUnlimited = true
				} else {
					taskBudget += kernelInt(node["budget"])
				}
				nodes = append(nodes, map[string]any{
					"id":                kernelString(node["id"]),
					"kind":              spec.Kind,
					"role":              role,
					"status":            kernelString(node["status"]),
					"used":              node["used"],
					"unlimited":         unlimited,
					"budget":            budget,
					"model":             node["model"],
					"definitionVersion": node["definition_version"],
					"stallCount":        kernelInt(node["stall_count"]),
					"outputVersion":     kernelInt(node["output_version"]),
				})
			}
		} else {
			nodes = append(nodes, KernelConversationNodes(runtime.kernel, taskId)...)
			for _, node := range KernelConversationNodes(runtime.kernel, taskId) {
				entry := asMap(node)
				if entry == nil {
					continue
				}
				taskUsed += kernelInt(entry["used"])
				if entry["unlimited"] == true {
					taskUnlimited = true
				} else {
					taskBudget += kernelInt(entry["budget"])
				}
			}
		}
		evidence := []any{}
		for _, item := range kernelRows(runtime.store.Db, "SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid", taskId) {
			evidence = append(evidence, map[string]any{
				"acceptanceId": kernelString(item["acceptance_id"]),
				"valid":        kernelInt(item["valid"]) != 0,
			})
		}
		cost := taskRuntimeTaskCost(runtime, taskId)
		taskCosts = append(taskCosts, cost)
		status := kernelString(row["phase"])
		if kernelInt(row["paused"]) != 0 {
			status = "paused"
		} else {
			status = StatusForQuestions(openQuestions, status)
		}
		tasks = append(tasks, map[string]any{
			"id":                      taskId,
			"request":                 kernelString(row["request"]),
			"phase":                   kernelString(row["phase"]),
			"paused":                  kernelInt(row["paused"]) != 0,
			"createdAt":               row["createdAt"],
			"status":                  status,
			"targetBranch":            row["target_branch"],
			"acceptedProposalVersion": row["accepted_proposal"],
			"integrationSha":          row["integration_sha"],
			"openQuestions":           openQuestions,
			"internalProblemCount":    internalProblems,
			"nodes":                   nodes,
			"cost":                    cost,
			"evidence":                evidence,
		})
	}
	var projectRoot any
	if conversation.ProjectId != nil {
		project := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", *conversation.ProjectId)
		if project != nil {
			projectRoot = kernelString(project["root"])
		}
	}
	messageCount := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", conversationId)["count"])
	continuations := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT operation_id AS operationId,resumed_operation_id AS resumedOperationId FROM rsi_continuations WHERE task_id=?", conversation.AnchorTaskId) {
		continuations = append(continuations, map[string]any{
			"operationId":        kernelString(row["operationId"]),
			"resumedOperationId": row["resumedOperationId"],
		})
	}
	// Unknown usage can be pending reconciliation before any priced invocation
	// exists (scripted adapters, recovery before settle); an open unknown_usage
	// question is authoritative that the cost is not known.
	masterUnknown := false
	masterQuestions := []map[string]any{}
	for _, question := range anchorQuestions {
		if kernelString(question["kind"]) == "unknown_usage" && kernelString(question["status"]) == "open" {
			masterUnknown = true
		}
		if kernelString(question["status"]) == "open" && kernelString(question["owner"]) == "user" {
			masterQuestions = append(masterQuestions, question)
		}
	}
	ledgerCost := taskRuntimeTaskCost(runtime, conversation.AnchorTaskId)
	masterCost := ledgerCost
	if masterUnknown && !ledgerCost.Unknown {
		masterCost.Unknown = true
	}
	merged := MergeCosts(append([]CostSummary{masterCost}, taskCosts...))
	if masterUnknown || unknownUsagePending {
		merged.Unknown = true
	}
	masterUsed := int64(0)
	masterBudget := int64(0)
	masterUnlimited := false
	if master != nil {
		masterUsed = kernelInt(master["used"])
		masterUnlimited = kernelInt(master["unlimited"]) != 0
		if !masterUnlimited {
			masterBudget = kernelInt(master["budget"])
		}
	}
	used := masterUsed + taskUsed
	anyUnlimited := masterUnlimited || taskUnlimited
	var budget any
	if !anyUnlimited {
		budget = masterBudget + taskBudget
	}
	knownMasterUsage := ConversationMasterUsage(runtime.store, conversationId)
	var contextLimit any
	contextWindow := 0
	var masterModel any
	if master != nil {
		masterModel = master["model"]
	}
	if model, ok := masterModel.(string); ok && model != "" {
		for _, entry := range runtime.liveEntries() {
			if entry.Id == model {
				// The catalog holds the window as an int, so the percentage is computed
				// from that number rather than from a type assertion on the view value:
				// the assertion never matched, and the footer printed a limit with no
				// percentage beside it.
				contextWindow = entry.ContextWindow
				if contextWindow > 0 {
					contextLimit = contextWindow
				}
				break
			}
		}
	}
	var cacheHitRate any
	if knownMasterUsage.CacheInput > 0 {
		cacheHitRate = float64(knownMasterUsage.CachedInput) / float64(knownMasterUsage.CacheInput)
	}
	var contextPercent any
	if knownMasterUsage.ContextTokens != nil && contextWindow > 0 {
		percent := float64(*knownMasterUsage.ContextTokens) / float64(contextWindow) * 100
		if percent > 100 {
			percent = 100
		}
		contextPercent = percent
	}
	telemetry := map[string]any{
		"model":           masterModel,
		"thinkingLevel":   conversation.ThinkingLevel,
		"cacheHitRate":    cacheHitRate,
		"cachedInput":     knownMasterUsage.CachedInput,
		"cacheInput":      knownMasterUsage.CacheInput,
		"cacheReadTokens": knownMasterUsage.CacheReadTokens,
		"cacheUsedAt":     knownMasterUsage.CacheUsedAt,
		"contextTokens":   knownMasterUsage.ContextTokens,
		"contextLimit":    contextLimit,
		"contextPercent":  contextPercent,
		// The newest request that wrote tokens: how many, how long, and the rate.
		"outputTokens":    knownMasterUsage.OutputTokens,
		"latencyMs":       knownMasterUsage.LatencyMs,
		"tokensPerSecond": knownMasterUsage.TokensPerSecond,
	}
	var masterView any
	if master != nil {
		masterView = map[string]any{
			"nodeId":            "master",
			"status":            kernelString(master["status"]),
			"model":             master["model"],
			"used":              master["used"],
			"unlimited":         masterUnlimited,
			"budget":            master["budget"],
			"definitionVersion": master["definition_version"],
			"cost":              masterCost,
			"questions":         masterQuestions,
		}
	}
	view := map[string]any{
		"id":                 conversation.Id,
		"role":               conversation.Role,
		"title":              conversation.Title,
		"projectId":          conversation.ProjectId,
		"projectRoot":        projectRoot,
		"archived":           conversation.ArchivedAt != nil,
		"archivedAt":         conversation.ArchivedAt,
		"paused":             anchor.Paused != 0,
		"workspaceProjectId": conversation.WorkspaceProjectId,
		"anchorTaskId":       conversation.AnchorTaskId,
		"createdAt":          conversation.CreatedAt,
		"requirementVersion": anchor.RequirementVersion,
		"eventCursor":        kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"]),
		"messages":           ListMessages(runtime.store, conversationId, messageQueryOf(query)),
		"messageCount":       messageCount,
		"streams":            ConversationStreams(runtime.store, conversationId),
		"continuations":      continuations,
		"questions":          anchorQuestions,
		"proposal":           proposal,
		"proposalHistory":    proposalHistory,
		"archivedProposals":  archivedProposals,
		"accepted":           accepted,
		"master":             masterView,
		"telemetry":          telemetry,
		"cost":               merged,
		"usage":              map[string]any{"used": used, "budget": budget, "unlimited": anyUnlimited},
		"tasks":              tasks,
		"cursor":             kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"]),
	}
	return view
}
