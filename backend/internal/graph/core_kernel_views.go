package graph

import (
	"encoding/json"
	"sort"
)

// NodeEntryQuery pages one node's transcript.
type NodeEntryQuery struct {
	After   *float64
	Before  *float64
	Limit   *float64
	EntryID *string
}

// NodeConfigurationSnapshot is the declaration frozen for one revision.
type NodeConfigurationSnapshot struct {
	Revision   int                `json:"revision"`
	Definition NodeDefinition     `json:"definition"`
	Defaults   *ExecutionSettings `json:"defaults"`
}

// NodeConfigurations compares the running declaration with the next one.
type NodeConfigurations struct {
	Current *NodeConfigurationSnapshot `json:"current"`
	Next    *NodeConfigurationSnapshot `json:"next"`
	Pending bool                       `json:"pending"`
}

// NodePromptView is the prompt a node was actually sent.
type NodePromptView struct {
	TaskID            string             `json:"taskId"`
	NodeID            string             `json:"nodeId"`
	Kind              string             `json:"kind"`
	Action            string             `json:"action"`
	Role              *string            `json:"role"`
	DefinitionVersion *string            `json:"definitionVersion"`
	Model             *string            `json:"model"`
	Status            string             `json:"status"`
	Configurations    NodeConfigurations `json:"configurations"`
	Recorded          any                `json:"recorded"`
	Briefing          any                `json:"briefing"`
	Notes             []string           `json:"notes"`
}

// KernelHasActiveWork is true while an agent turn or module worker is still running.
func KernelHasActiveWork(kernel *KernelStore, graphID string) bool {
	row := kernelRow(kernel.DB, `SELECT 1 WHERE
    EXISTS(SELECT 1 FROM kernel_executions WHERE task_id=? AND state='running') OR
    EXISTS(SELECT 1 FROM kernel_module_operations WHERE task_id=? AND worker_active=1)`, graphID, graphID)
	return row != nil
}

// KernelGraphView is the newest revision plus one-delivery edge and module cards.
func KernelGraphView(kernel *KernelStore, graphID string) any {
	revision := kernel.LatestRevision(graphID)
	if revision == nil {
		return nil
	}
	definition := revision.Definition
	edgeIDs := sortedKeys(definition.Edges)
	edges := []EdgeExplanation{}
	for _, id := range edgeIDs {
		edges = append(edges, ExplainEdge(kernel, graphID, id, nil, EdgeHistoryQuery{Limit: 1}))
	}
	moduleIDs := make([]string, 0, len(definition.Modules))
	for id := range definition.Modules {
		moduleIDs = append(moduleIDs, id)
	}
	sort.Strings(moduleIDs)
	modules := []any{}
	for _, id := range moduleIDs {
		explained := ExplainModule(kernel, graphID, id, ModuleHistoryQuery{IncludeTransitions: boolPtr(false)})
		modules = append(modules, struct {
			ModuleExplanation
			Definition ModuleDefinition `json:"definition"`
		}{explained, definition.Modules[id]})
	}
	return struct {
		GraphID    string            `json:"graphId"`
		Definition GraphDefinition   `json:"definition"`
		Revision   int               `json:"revision"`
		Edges      []EdgeExplanation `json:"edges"`
		Modules    []any             `json:"modules"`
		Nodes      any               `json:"nodes"`
	}{graphID, definition, revision.Version, edges, modules, kernel.ListNodes(graphID)}
}

func boolPtr(value bool) *bool { return &value }

// KernelConversationNodes reads native node cards without session pages.
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

// KernelNodeRun is the node detail, including transcript page fields from ListNodeEntries.
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
		Evidence         []any              `json:"evidence"`
		Timing           any                `json:"timing"`
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
		Operations: operations, Invocations: invocations, Questions: []any{}, Evidence: []any{},
		Timing: map[string]any{"totalMs": totalMs, "runMs": totalMeasured("runMs"), "waitingMs": totalMeasured("waitingMs"),
			"pauseMs": NativePauseMs(kernel.Store, graphID, nodeID), "userWaitMs": nil, "inProgress": inProgress},
		Entries: page["entries"], EntryCount: page["entryCount"], Limit: page["limit"], HasOlder: page["hasOlder"], HasNewer: page["hasNewer"],
		Phase: kernel.Store.Task(graphID).Phase,
	}
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

// KernelNodePrompt reports the recorded send, never a recomputed prompt.
func KernelNodePrompt(kernel *KernelStore, graphID, nodeID string) NodePromptView {
	row, definition := historicalNode(kernel, graphID, nodeID)
	if row == nil || definition == nil {
		Raise("not_found", "Unknown node "+nodeID)
	}
	record := kernelRow(kernel.DB, "SELECT execution_id,system_prompt,tools,created_at FROM kernel_prompts WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1", graphID, nodeID)
	first := kernelRow(kernel.DB, "SELECT text FROM node_entries WHERE task_id=? AND node_id=? AND role='user' ORDER BY seq LIMIT 1", graphID, nodeID)
	session := kernelRow(kernel.DB, "SELECT session_file FROM node_sessions WHERE instance_id=?", row["instanceId"])
	binding := kernelRow(kernel.DB, "SELECT model_id,role,environment FROM kernel_node_bindings WHERE task_id=? AND node_id=?", graphID, nodeID)
	configurations := nodeConfigurations(kernel, graphID, nodeID, "")
	var recordedConfiguration *NodeConfigurationSnapshot
	var recordedCall map[string]any
	if record != nil {
		recordedConfiguration = nodeConfigurations(kernel, graphID, nodeID, kernelString(record["execution_id"])).Current
		for _, call := range asSlice(kernel.ProviderCalls(graphID, nodeID)) {
			item := asMap(call)
			if mapString(item, "executionId") == kernelString(record["execution_id"]) {
				recordedCall = item
			}
		}
	}
	action := definition.Task
	var definitionVersion *string
	if definition.Recipe != "" {
		text := definition.Recipe
		definitionVersion = &text
	}
	if recordedConfiguration != nil {
		action = recordedConfiguration.Definition.Task
		if recordedConfiguration.Definition.Recipe != "" {
			text := recordedConfiguration.Definition.Recipe
			definitionVersion = &text
		}
	}
	var role *string
	if binding != nil && binding["role"] != nil {
		text := kernelString(binding["role"])
		role = &text
	}
	var model *string
	if record != nil && recordedCall != nil {
		if id := mapString(asMap(recordedCall["model"]), "id"); id != "" {
			model = &id
		}
	}
	var recorded any
	notes := []string{}
	if record != nil {
		recorded = map[string]any{"operationId": kernelString(record["execution_id"]), "at": kernelInt(record["created_at"]), "text": kernelString(record["system_prompt"]), "tools": record["tools"]}
	} else {
		notes = []string{"尚无实际模型发送记录。"}
	}
	var briefing any
	if first != nil {
		file := ""
		if session != nil && session["session_file"] != nil {
			file = kernelString(session["session_file"])
		}
		briefing = map[string]any{"text": kernelString(first["text"]), "sessionFile": file}
	}
	return NodePromptView{
		TaskID: graphID, NodeID: nodeID, Kind: "agent", Action: action, Role: role, DefinitionVersion: definitionVersion,
		Model: model, Status: kernelString(row["status"]), Configurations: configurations, Recorded: recorded, Briefing: briefing, Notes: notes,
	}
}

// KernelModelsInUse is the set of model ids unfinished work still depends on.
func KernelModelsInUse(kernel *KernelStore) []string {
	used := []string{}
	seen := map[string]bool{}
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		used = append(used, id)
	}
	revisions := map[string]GraphDefinition{}
	rows := kernelRows(kernel.DB, `SELECT n.task_id,n.node_id,n.spec,b.model_id,e.revision_version,e.state
    FROM kernel_nodes n JOIN tasks t ON t.id=n.task_id
    LEFT JOIN kernel_node_bindings b ON b.task_id=n.task_id AND b.node_id=n.node_id
    LEFT JOIN kernel_executions e ON e.rowid=(SELECT MAX(x.rowid) FROM kernel_executions x WHERE x.task_id=n.task_id AND x.node_id=n.node_id)
    WHERE n.status!='retired' AND t.phase NOT IN ('completed','stopped','abandoned')`)
	for _, row := range rows {
		configured := asMap(parseJSON(kernelString(row["spec"])))
		if mapHas(configured, "model") && configured["model"] != nil {
			add(mapString(configured, "model"))
		}
		if row["model_id"] == nil || kernelString(row["model_id"]) == "" {
			continue
		}
		modelID := kernelString(row["model_id"])
		if kernelString(row["state"]) == "running" || row["revision_version"] == nil {
			add(modelID)
			continue
		}
		key := kernelString(row["task_id"]) + ":" + itoa(int(kernelInt(row["revision_version"])))
		if _, ok := revisions[key]; !ok {
			if revision := kernel.Revision(kernelString(row["task_id"]), int(kernelInt(row["revision_version"]))); revision != nil {
				revisions[key] = revision.Definition
			}
		}
		definition, ok := revisions[key]
		var previous *NodeDefinition
		if ok {
			if node, found := definition.Nodes[kernelString(row["node_id"])]; found {
				previous = &node
			}
		}
		configuredModel := mapHas(configured, "model") && configured["model"] != nil
		sameModel := previous != nil && ((configuredModel && previous.Model != nil && mapString(configured, "model") == *previous.Model) || (!configuredModel && previous.Model == nil))
		sameRecipe := previous != nil && mapString(configured, "recipe") == previous.Recipe
		if previous == nil || (sameModel && sameRecipe) {
			add(modelID)
		}
	}
	return used
}
