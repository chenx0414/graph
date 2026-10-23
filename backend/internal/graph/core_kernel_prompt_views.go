package graph

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
