package graph

import (
	"encoding/json"
)

func (runtime *TaskRuntime) Models() []map[string]any {
	runtime.ensureOpen()
	out := []map[string]any{}
	for _, entry := range runtime.liveEntries() {
		view := ModelEntryView{ModelEntry: entry, ThinkingOptions: ThinkingOptionsFor(entry)}
		raw, err := json.Marshal(view)
		if err != nil {
			panic(err)
		}
		record := map[string]any{}
		if err := json.Unmarshal(raw, &record); err != nil {
			panic(err)
		}
		out = append(out, record)
	}
	return out
}

func (runtime *TaskRuntime) DefaultModel() *string {
	runtime.ensureOpen()
	return runtime.masterModel()
}

func (runtime *TaskRuntime) CurrentAccessPolicy() *ResolvedAccessPolicy {
	runtime.ensureOpen()
	return runtime.resolvedAccessPolicy()
}

func (runtime *TaskRuntime) ModelLimits() ModelSchedulerSnapshot {
	runtime.ensureOpen()
	return runtime.scheduler.Snapshot()
}

func (runtime *TaskRuntime) ModelsInUse() []string {
	runtime.ensureOpen()
	seen := map[string]bool{}
	out := []string{}
	for _, row := range kernelRows(runtime.store.Db, `SELECT DISTINCT i.model AS model FROM nodes n JOIN instances i ON i.id=n.instance_id JOIN tasks t ON t.id=n.task_id
    WHERE t.phase IN ('discussing','running','queued') AND n.status NOT IN ('succeeded','skipped') AND i.model IS NOT NULL`) {
		model := kernelString(row["model"])
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	for _, model := range KernelModelsInUse(runtime.kernel) {
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	return out
}

func (runtime *TaskRuntime) GraphMessages(taskId string) []map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	out := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, `SELECT id,json_extract(data,'$.from') AS source,node_id AS target,text,created_at AS createdAt
    FROM node_entries WHERE task_id=? AND kind='chat'
    AND json_extract(data,'$.peer')=1 AND json_extract(data,'$.from') IS NOT NULL ORDER BY seq`, taskId) {
		out = append(out, map[string]any{
			"id":        kernelString(row["id"]),
			"source":    kernelString(row["source"]),
			"target":    kernelString(row["target"]),
			"text":      kernelString(row["text"]),
			"createdAt": kernelInt(row["createdAt"]),
		})
	}
	return out
}

func (runtime *TaskRuntime) GraphLayout(taskId string, revision int) map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	epoch := kernelInt(kernelRow(runtime.kernel.Db, "SELECT COALESCE(MAX(cursor),0) AS epoch FROM events WHERE task_id=? AND type='graph.layout_reset'", taskId)["epoch"])
	snapshot := runtime.kernel.GraphLayoutSnapshot(taskId, revision)
	return map[string]any{"epoch": epoch, "snapshot": snapshot}
}

func (runtime *TaskRuntime) SaveGraphLayout(taskId string, revision int, topology string, layout Json, epoch int64) bool {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	current := kernelInt(kernelRow(runtime.kernel.Db, "SELECT COALESCE(MAX(cursor),0) AS epoch FROM events WHERE task_id=? AND type='graph.layout_reset'", taskId)["epoch"])
	if current != epoch {
		return false
	}
	runtime.kernel.KeepGraphLayout(taskId, revision, topology, CanonicalJSON(layout))
	return true
}

func (runtime *TaskRuntime) GraphModule(taskId, moduleId string, query ModuleHistoryQuery) ModuleExplanation {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	return ExplainModule(runtime.kernel, taskId, moduleId, query)
}

func (runtime *TaskRuntime) GraphEdge(taskId, edgeId string, query EdgeHistoryQuery) EdgeExplanation {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	return ExplainEdge(runtime.kernel, taskId, edgeId, nil, query)
}

func (runtime *TaskRuntime) KernelGraph(taskId string) any {
	runtime.ensureOpen()
	return KernelGraphView(runtime.kernel, taskId)
}

func (runtime *TaskRuntime) NodeRun(taskId, nodeId string, query NodeEntryQuery) any {
	runtime.ensureOpen()
	if runtime.kernel.LatestRevision(taskId) != nil {
		return KernelNodeRun(runtime.kernel, taskId, nodeId, query)
	}
	return NodeRun(runtime.store, taskId, nodeId, query)
}

func (runtime *TaskRuntime) NodePrompt(taskId, nodeId string) NodePromptView {
	runtime.ensureOpen()
	if runtime.kernel.LatestRevision(taskId) != nil {
		return KernelNodePrompt(runtime.kernel, taskId, nodeId)
	}
	return NodePromptDetail(runtime.store, taskId, nodeId)
}

func (runtime *TaskRuntime) AgentWorkspace(taskId, nodeId string) *string {
	runtime.ensureOpen()
	row := kernelRow(runtime.store.Db, "SELECT instance_id,spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	task := runtime.store.Task(taskId)
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	var instanceId *string
	if row["instance_id"] != nil {
		value := kernelString(row["instance_id"])
		instanceId = &value
	}
	workspace := runtime.git.Workspace(taskId, instanceId, nodeId, spec.Kind, spec.Action)
	if workspace != nil {
		return workspace
	}
	project := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
	if project == nil {
		return nil
	}
	root := kernelString(project["root"])
	return &root
}

func (runtime *TaskRuntime) ProjectEntries(projectId, query string, limit int) []ProjectPathEntry {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[projectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	return runtime.git.VisiblePaths(projectId, query, limit)
}

func (runtime *TaskRuntime) SendNodeMessage(taskId, nodeId string, input NodeMessageInput) any {
	runtime.ensureOpen()
	receipt := SendKernelNodeMessage(runtime.kernel, taskId, nodeId, input, nil)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return receipt
}

type TaskRuntimePeerInput struct {
	To        string
	Text      string
	RequestId string
}

func (runtime *TaskRuntime) SendPeerMessage(taskId, from string, input TaskRuntimePeerInput) any {
	runtime.ensureOpen()
	nodeInput := NodeMessageInput{Text: input.Text, RequestID: input.RequestId}
	var receipt any
	if input.To == "main" {
		receipt = SendKernelMainMessage(runtime.kernel, taskId, from, nodeInput)
	} else {
		sender := from
		receipt = SendKernelNodeMessage(runtime.kernel, taskId, input.To, nodeInput, &sender)
	}
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return receipt
}
