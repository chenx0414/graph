package graph

import (
	"encoding/json"
)

type NodeEntryQuery struct {
	After         *float64
	Before        *float64
	Limit         *float64
	EntryID       *string
	OpenQuestions bool
	Lean          bool
}

type NodeConfigurationSnapshot struct {
	Revision   int                `json:"revision"`
	Definition NodeDefinition     `json:"definition"`
	Defaults   *ExecutionSettings `json:"defaults"`
}

type NodeConfigurations struct {
	Current *NodeConfigurationSnapshot `json:"current"`
	Next    *NodeConfigurationSnapshot `json:"next"`
	Pending bool                       `json:"pending"`
}

func KernelConversationNodes(kernel *KernelStore, graphID string) []any {
	rows := kernelRows(kernel.DB, `SELECT n.node_id,n.spec,n.status,b.role,b.model_id,s.used,e.token_budget
    FROM kernel_nodes n LEFT JOIN kernel_node_bindings b ON b.task_id=n.task_id AND b.node_id=n.node_id
    LEFT JOIN kernel_node_state s ON s.task_id=n.task_id AND s.node_id=n.node_id
    LEFT JOIN kernel_executions e ON e.rowid=(SELECT MAX(rowid) FROM kernel_executions WHERE task_id=n.task_id AND node_id=n.node_id)
    WHERE n.task_id=? ORDER BY n.rowid`, graphID)
	out := []any{}
	for _, row := range rows {
		spec := asMap(parseJSON(kernelString(row["spec"])))
		var budget map[string]any
		if row["token_budget"] != nil {
			budget = asMap(parseJSON(kernelString(row["token_budget"])))
		}
		unlimited := budget != nil && budget["unlimited"] == true
		var budgetValue any
		if !unlimited && budget != nil {
			budgetValue = budget["budget"]
		}
		var recipe any
		if spec["recipe"] != nil {
			recipe = spec["recipe"]
		}
		var role any
		if row["role"] != nil {
			role = kernelString(row["role"])
		}
		var model any
		if row["model_id"] != nil {
			model = kernelString(row["model_id"])
		}
		out = append(out, struct {
			ID                string `json:"id"`
			Kind              string `json:"kind"`
			Role              any    `json:"role"`
			Status            string `json:"status"`
			Used              int64  `json:"used"`
			Unlimited         bool   `json:"unlimited"`
			Budget            any    `json:"budget"`
			Model             any    `json:"model"`
			DefinitionVersion any    `json:"definitionVersion"`
			StallCount        int    `json:"stallCount"`
			OutputVersion     int    `json:"outputVersion"`
		}{
			ID: kernelString(row["node_id"]), Kind: "agent", Role: role, Status: kernelString(row["status"]),
			Used: kernelInt(row["used"]), Unlimited: unlimited, Budget: budgetValue, Model: model,
			DefinitionVersion: recipe, StallCount: 0, OutputVersion: 0,
		})
	}
	return out
}

func historicalNode(kernel *KernelStore, graphID, nodeID string) (map[string]any, *NodeDefinition) {
	row := kernelRow(kernel.DB, "SELECT instance_id AS instanceId,status,spec FROM kernel_nodes WHERE task_id=? AND node_id=?", graphID, nodeID)
	if row == nil {
		return nil, nil
	}
	var definition NodeDefinition
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &definition); err != nil {
		panic(err)
	}
	return row, &definition
}

func nodeConfigurations(kernel *KernelStore, graphID, nodeID, executionID string) NodeConfigurations {
	var execution map[string]any
	if executionID != "" {
		execution = kernelRow(kernel.DB, `SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND id=? ORDER BY rowid DESC LIMIT 1`, graphID, nodeID, executionID)
	} else {
		execution = kernelRow(kernel.DB, `SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1`, graphID, nodeID)
	}
	snapshot := func(revision *struct {
		Version    int
		Definition GraphDefinition
	}) *NodeConfigurationSnapshot {
		return nil
	}
	_ = snapshot
	take := func(version int, definition GraphDefinition, ok bool) *NodeConfigurationSnapshot {
		if !ok {
			return nil
		}
		node, found := definition.Nodes[nodeID]
		if !found {
			return nil
		}
		return &NodeConfigurationSnapshot{Revision: version, Definition: node, Defaults: definition.Defaults}
	}
	var current *NodeConfigurationSnapshot
	if execution != nil {
		rev := kernel.Revision(graphID, int(kernelInt(execution["revision_version"])))
		if rev != nil {
			current = take(rev.Version, rev.Definition, true)
		}
	}
	next := (*NodeConfigurationSnapshot)(nil)
	if latest := kernel.LatestRevision(graphID); latest != nil {
		next = take(latest.Version, latest.Definition, true)
	}
	pending := false
	if current != nil {
		left := CanonicalJSON([]any{current.Definition, current.Defaults})
		var nextDefinition any
		var nextDefaults any
		if next != nil {
			nextDefinition = next.Definition
			nextDefaults = next.Defaults
		}
		pending = left != CanonicalJSON([]any{nextDefinition, nextDefaults})
	}
	return NodeConfigurations{Current: current, Next: next, Pending: pending}
}

func kernelNodeThroughput(kernel *KernelStore, graphID, nodeID string) NodeThroughput {
	row := kernelRow(kernel.DB, `SELECT usage AS usage, created_at AS createdAt, settled_at AS settledAt
    FROM kernel_provider_calls
    WHERE task_id=? AND node_id=? AND settled_at > created_at
      AND json_extract(usage,'$.output') > 0
    ORDER BY settled_at DESC LIMIT 1`, graphID, nodeID)
	facts := throughputFactsOf(row)
	return NodeThroughput{
		OutputTokens: facts.OutputTokens, LatencyMs: facts.LatencyMs, TokensPerSecond: facts.TokensPerSecond,
		FirstTokenMs: facts.FirstTokenMs, UploadMs: facts.UploadMs, ServerWaitMs: facts.ServerWaitMs,
	}
}

func KernelNodeRun(kernel *KernelStore, graphID, nodeID string, query NodeEntryQuery) any {
	row, definition := historicalNode(kernel, graphID, nodeID)
	if row == nil || definition == nil {
		Raise("not_found", "Unknown node "+nodeID)
	}
	binding := kernelRow(kernel.DB, "SELECT model_id,role,environment FROM kernel_node_bindings WHERE task_id=? AND node_id=?", graphID, nodeID)
	state := kernelRow(kernel.DB, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", graphID, nodeID)
	session := kernelRow(kernel.DB, "SELECT session_id,session_file FROM node_sessions WHERE instance_id=?", row["instanceId"])
	now := NowMillis()
	executionRows := kernelRows(kernel.DB, "SELECT id,attempt,state,submission_id,started_at,ended_at,retries_used,resubmits_used,token_budget,token_reservation,waiting_slot,run_ms,waiting_ms,run_since,waiting_since FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid", graphID, nodeID)
	executions := []map[string]any{}
	for _, item := range executionRows {
		runMs := any(nil)
		if item["run_ms"] != nil {
			extra := int64(0)
			if item["run_since"] != nil {
				delta := now - kernelInt(item["run_since"])
				if delta > 0 {
					extra = delta
				}
			}
			runMs = kernelInt(item["run_ms"]) + extra
		}
		waitingMs := any(nil)
		if item["waiting_ms"] != nil {
			extra := int64(0)
			if item["waiting_since"] != nil {
				delta := now - kernelInt(item["waiting_since"])
				if delta > 0 {
					extra = delta
				}
			}
			waitingMs = kernelInt(item["waiting_ms"]) + extra
		}
		executions = append(executions, map[string]any{
			"id": item["id"], "attempt": item["attempt"], "state": item["state"], "submission_id": item["submission_id"],
			"started_at": item["started_at"], "ended_at": item["ended_at"], "retries_used": item["retries_used"],
			"resubmits_used": item["resubmits_used"], "token_budget": item["token_budget"], "token_reservation": item["token_reservation"],
			"waiting_slot": item["waiting_slot"], "runMs": runMs, "waitingMs": waitingMs,
		})
	}
	capability := kernelRow(kernel.DB, "SELECT loaded FROM node_capabilities WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1", graphID, nodeID)
	var loaded map[string]any
	if capability != nil && capability["loaded"] != nil {
		loaded = asMap(parseJSON(kernelString(capability["loaded"])))
	}
	calls := asSlice(kernel.ProviderCalls(graphID, nodeID))
	var budget map[string]any
	if len(executions) > 0 && executions[len(executions)-1]["token_budget"] != nil {
		budget = asMap(parseJSON(kernelString(executions[len(executions)-1]["token_budget"])))
	}
	configurations := nodeConfigurations(kernel, graphID, nodeID, "")
	countRow := kernelRow(kernel.DB, `SELECT COUNT(*) AS count FROM node_entries WHERE task_id=? AND node_id=? AND role='tool' AND kind='call'`, graphID, nodeID)
	toolCallCount := int64(0)
	if countRow != nil {
		toolCallCount = kernelInt(countRow["count"])
	}
	settled := []map[string]any{}
	for _, item := range executions {
		if item["ended_at"] != nil {
			settled = append(settled, item)
		}
	}
	totalMeasured := func(field string) any {
		if len(executions) == 0 {
			return nil
		}
		total := int64(0)
		for _, item := range executions {
			if item[field] == nil {
				return nil
			}
			total += kernelInt(item[field])
		}
		return total
	}
	var totalMs any
	if len(settled) > 0 {
		total := int64(0)
		for _, item := range settled {
			total += kernelInt(item["ended_at"]) - kernelInt(item["started_at"])
		}
		totalMs = total
	}
	inProgress := false
	for _, item := range executions {
		if kernelString(item["state"]) == "running" {
			inProgress = true
		}
	}
	var environment any
	if binding != nil && binding["environment"] != nil && kernelString(binding["environment"]) != "" {
		environment = parseJSON(kernelString(binding["environment"]))
	}
	var role any
	var modelID any
	if binding != nil {
		if binding["role"] != nil {
			role = kernelString(binding["role"])
		}
		if binding["model_id"] != nil {
			modelID = kernelString(binding["model_id"])
		}
	}
	var recipe any
	if definition.Recipe != "" {
		recipe = definition.Recipe
	}
	var currentRecipe any
	if configurations.Current != nil && configurations.Current.Definition.Recipe != "" {
		currentRecipe = configurations.Current.Definition.Recipe
	}
	used := int64(0)
	reserved := int64(0)
	if state != nil {
		used = kernelInt(state["used"])
		reserved = kernelInt(state["reserved"])
	}
	unlimited := budget != nil && budget["unlimited"] == true
	var budgetValue any
	if !unlimited && budget != nil {
		budgetValue = budget["budget"]
	}
	modelsUsed := []string{}
	seenModel := map[string]bool{}
	for _, call := range calls {
		record := asMap(call)
		model := asMap(record["model"])
		id := mapString(model, "id")
		if id != "" && !seenModel[id] {
			seenModel[id] = true
			modelsUsed = append(modelsUsed, id)
		}
	}
	var sessionView any
	if session != nil {
		var file any
		if session["session_file"] != nil {
			file = kernelString(session["session_file"])
		}
		sessionView = map[string]any{"sessionId": kernelString(session["session_id"]), "sessionFile": file}
	}
	facts := []any{}
	var digest any
	if loaded != nil {
		if list := asSlice(loaded["facts"]); list != nil {
			facts = list
		}
		digest = loaded["digest"]
	}
	operations := []any{}
	for _, item := range executions {
		var tokenBudget any
		if item["token_budget"] != nil {
			tokenBudget = parseJSON(kernelString(item["token_budget"]))
		}
		var elapsed any
		if item["ended_at"] != nil {
			elapsed = kernelInt(item["ended_at"]) - kernelInt(item["started_at"])
		}
		operations = append(operations, map[string]any{
			"id": item["id"], "attempt": item["attempt"], "state": item["state"], "submission_id": item["submission_id"],
			"started_at": item["started_at"], "ended_at": item["ended_at"], "retries_used": item["retries_used"],
			"resubmits_used": item["resubmits_used"], "token_budget": item["token_budget"], "token_reservation": item["token_reservation"],
			"waiting_slot": item["waiting_slot"], "runMs": item["runMs"], "waitingMs": item["waitingMs"],
			"activationId": item["id"], "workerActive": kernelString(item["state"]) == "running", "waitingSlot": kernelInt(item["waiting_slot"]) == 1,
			"reserved": item["token_reservation"], "tokenBudget": tokenBudget, "elapsedMs": elapsed,
			"dispatchedAt": item["started_at"], "settledAt": item["ended_at"], "result": nil, "usage": nil,
		})
	}
	invocations := []any{}
	for _, call := range calls {
		record := asMap(call)
		model := asMap(record["model"])
		stateName := mapString(record, "state")
		reservedCall := any(0)
		if stateName == "inflight" || stateName == "unknown" {
			reservedCall = record["reserved"]
		}
		var usage any
		if record["usage"] != nil {
			usage = record["usage"]
		}
		invocations = append(invocations, map[string]any{
			"id": record["id"], "operationId": firstPresent(record, "executionId", "execution_id"), "model": nullableString(model, "id"),
			"modelIdentity": nullableString(model, "identity"), "provider": nullableString(model, "provider"), "state": stateName,
			"reserved": reservedCall, "usage": usage, "usageSource": string(UsageSourceOf(tokenUsagePtr(usage))),
			"cost": record["cost"], "purpose": record["purpose"], "dispatchedAt": firstPresent(record, "createdAt", "created_at"),
			"settledAt": firstPresent(record, "settledAt", "settled_at"),
		})
	}
	page := asMap(ListNodeEntries(kernel.Store, graphID, nodeID, query))
	questions := []any{}
	for _, row := range kernelRows(kernel.DB, "SELECT id,kind,status,data FROM questions WHERE task_id=? AND node_id=? ORDER BY rowid", graphID, nodeID) {
		questions = append(questions, map[string]any{
			"id": kernelString(row["id"]), "kind": kernelString(row["kind"]),
			"status": kernelString(row["status"]), "data": parseJSON(kernelString(row["data"])),
		})
	}
	queued := []map[string]any{}
	for _, row := range kernelRows(kernel.DB, "SELECT seq,payload,created_at FROM kernel_queue WHERE task_id=? AND node_id=? AND state='queued' AND kind='chat' ORDER BY seq", graphID, nodeID) {
		text := ""
		if payload := asMap(parseJSON(kernelString(row["payload"]))); payload != nil {
			text = kernelString(payload["text"])
		}
		queued = append(queued, map[string]any{"seq": kernelInt(row["seq"]), "text": text, "createdAt": kernelInt(row["created_at"])})
	}
	return struct {
		TaskID           string             `json:"taskId"`
		NodeID           string             `json:"nodeId"`
		Context          any                `json:"context"`
		Configurations   NodeConfigurations `json:"configurations"`
		ToolCallCount    int64              `json:"toolCallCount"`
		Environment      any                `json:"environment"`
		Node             any                `json:"node"`
		Instance         any                `json:"instance"`
		Session          any                `json:"session"`
		Capabilities     any                `json:"capabilities"`
		CapabilityDigest any                `json:"capabilityDigest"`
		CapabilityUsage  []any              `json:"capabilityUsage"`
		Operations       []any              `json:"operations"`
		Invocations      []any              `json:"invocations"`
		Questions        []any              `json:"questions"`
		Queued           []map[string]any   `json:"queued"`
		Evidence         []any              `json:"evidence"`
		Timing           any                `json:"timing"`
		Throughput       any                `json:"throughput"`
		Entries          any                `json:"entries"`
		EntryCount       any                `json:"entryCount"`
		Limit            any                `json:"limit"`
		HasOlder         any                `json:"hasOlder"`
		HasNewer         any                `json:"hasNewer"`
		Phase            string             `json:"phase"`
	}{
		TaskID: graphID, NodeID: nodeID, Context: nil, Configurations: configurations, ToolCallCount: toolCallCount,
		Environment: environment,
		Node:        map[string]any{"id": nodeID, "kind": "agent", "action": definition.Task, "role": role, "status": kernelString(row["status"]), "definitionVersion": recipe},
		Instance: map[string]any{"id": kernelString(row["instanceId"]), "model": modelID, "definitionVersion": currentRecipe,
			"authorizedBudget": kernel.AuthorizedBudget(graphID, nodeID), "used": used, "budget": budgetValue, "unlimited": unlimited,
			"reserved": reserved, "modelsUsed": modelsUsed},
		Session: sessionView, Capabilities: facts, CapabilityDigest: digest, CapabilityUsage: []any{},
		Operations: operations, Invocations: invocations, Questions: questions, Queued: queued, Evidence: []any{},
		Timing: map[string]any{"totalMs": totalMs, "runMs": totalMeasured("runMs"), "waitingMs": totalMeasured("waitingMs"),
			"pauseMs": kernel.NativePauseMs(graphID, nodeID), "userWaitMs": nil, "inProgress": inProgress},
		Throughput: kernelNodeThroughput(kernel, graphID, nodeID),
		Entries:    page["entries"], EntryCount: page["entryCount"], Limit: page["limit"], HasOlder: page["hasOlder"], HasNewer: page["hasNewer"],
		Phase: kernelNodePhase(kernel, graphID),
	}
}

func kernelNodePhase(kernel *KernelStore, graphID string) string {
	row := kernelRow(kernel.DB, "SELECT paused FROM tasks WHERE id=?", graphID)
	paused := row != nil && kernelInt(row["paused"]) != 0
	return string(displayPhase(kernel.Store.Task(graphID).Phase, paused))
}

func firstPresent(record map[string]any, keys ...string) any {
	for _, key := range keys {
		if record[key] != nil {
			return record[key]
		}
	}
	return nil
}

func nullableString(record map[string]any, key string) any {
	if record == nil || record[key] == nil {
		return nil
	}
	if text, ok := record[key].(string); ok {
		return text
	}
	return record[key]
}

func tokenUsagePtr(value any) *TokenUsage {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var usage TokenUsage
	if err := json.Unmarshal(raw, &usage); err != nil {
		return nil
	}
	return &usage
}
