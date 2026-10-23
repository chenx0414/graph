package graph

import (
	"encoding/json"
)

// Models reads the configured models right now.
func (runtime *TaskRuntime) Models() []map[string]any {
	runtime.ensureOpen()
	out := []map[string]any{}
	for _, entry := range runtime.liveEntries() {
		record := map[string]any{
			"id":              entry.Id,
			"provider":        entry.Provider,
			"grade":           string(entry.Grade),
			"api":             string(entry.Api),
			"baseUrl":         entry.BaseUrl,
			"contextWindow":   entry.ContextWindow,
			"maxTokens":       entry.MaxTokens,
			"tier":            string(ModelTierOf(entry.Grade)),
			"thinkingOptions": ThinkingOptionsFor(entry),
		}
		out = append(out, record)
	}
	return out
}

// DefaultModel is the model a new conversation would use before any override.
func (runtime *TaskRuntime) DefaultModel() *string {
	runtime.ensureOpen()
	return runtime.masterModel()
}

// CurrentAccessPolicy is the policy the next admitted operation would get.
func (runtime *TaskRuntime) CurrentAccessPolicy() *ResolvedAccessPolicy {
	runtime.ensureOpen()
	return runtime.resolvedAccessPolicy()
}

// ModelLimits reports which credentials are busy and which requests wait.
func (runtime *TaskRuntime) ModelLimits() ModelSchedulerSnapshot {
	runtime.ensureOpen()
	return runtime.scheduler.Snapshot()
}

// ModelsInUse lists the model ids bound to tasks that have not finished.
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

// InboxHistory reads the resolved questions across the conversation anchors.
func (runtime *TaskRuntime) InboxHistory(limit int) []map[string]any {
	runtime.ensureOpen()
	cap := limit
	if cap <= 0 {
		cap = 100
	}
	if cap > 500 {
		cap = 500
	}
	out := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, `SELECT q.id,q.task_id AS taskId,q.node_id AS nodeId,q.kind,q.status,q.data,q.answer,q.owner,
    t.request,t.project_id AS projectId,t.conversation_id AS conversationId
    FROM questions q JOIN tasks t ON t.id=q.task_id
    WHERE q.status='resolved' AND q.owner='user'
    ORDER BY q.rowid DESC LIMIT ?`, cap) {
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
		out = append(out, map[string]any{
			"id":             kernelString(row["id"]),
			"taskId":         kernelString(row["taskId"]),
			"nodeId":         kernelString(row["nodeId"]),
			"kind":           kernelString(row["kind"]),
			"status":         kernelString(row["status"]),
			"owner":          kernelString(row["owner"]),
			"data":           data,
			"answer":         answer,
			"request":        kernelString(row["request"]),
			"projectId":      kernelString(row["projectId"]),
			"conversationId": row["conversationId"],
		})
	}
	return out
}

// GraphMessages reads the peer messages of one task.
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

// GraphLayout reads the stored layout of one graph revision.
func (runtime *TaskRuntime) GraphLayout(taskId string, revision int) map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	epoch := kernelInt(kernelRow(runtime.kernel.Db, "SELECT COALESCE(MAX(cursor),0) AS epoch FROM events WHERE task_id=? AND type='graph.layout_reset'", taskId)["epoch"])
	row := kernelRow(runtime.kernel.Db, "SELECT topology,layout FROM kernel_graph_layouts WHERE task_id=? AND revision_version<=? ORDER BY revision_version DESC LIMIT 1", taskId, revision)
	var snapshot any
	if row != nil {
		snapshot = map[string]any{"topology": kernelString(row["topology"]), "layout": parseJSON(kernelString(row["layout"]))}
	}
	return map[string]any{"epoch": epoch, "snapshot": snapshot}
}

// SaveGraphLayout stores the layout of one graph revision.
func (runtime *TaskRuntime) SaveGraphLayout(taskId string, revision int, topology string, layout Json, epoch int64) bool {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	current := kernelInt(kernelRow(runtime.kernel.Db, "SELECT COALESCE(MAX(cursor),0) AS epoch FROM events WHERE task_id=? AND type='graph.layout_reset'", taskId)["epoch"])
	if current != epoch {
		return false
	}
	kernelExec(runtime.kernel.Db, "INSERT OR IGNORE INTO kernel_graph_layouts(task_id,revision_version,topology,layout) VALUES(?,?,?,?)",
		taskId, revision, topology, CanonicalJSON(layout))
	return true
}

// GraphModule explains one module of a graph.
func (runtime *TaskRuntime) GraphModule(taskId, moduleId string, query ModuleHistoryQuery) ModuleExplanation {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	return ExplainModule(runtime.kernel, taskId, moduleId, query)
}

// GraphEdge explains one edge of a graph.
func (runtime *TaskRuntime) GraphEdge(taskId, edgeId string, query EdgeHistoryQuery) EdgeExplanation {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	return ExplainEdge(runtime.kernel, taskId, edgeId, nil, query)
}

// KernelGraph reads the native graph of one task.
func (runtime *TaskRuntime) KernelGraph(taskId string) any {
	runtime.ensureOpen()
	return KernelGraphView(runtime.kernel, taskId)
}

// NodeRun reads the node detail of one task.
func (runtime *TaskRuntime) NodeRun(taskId, nodeId string, query NodeEntryQuery) any {
	runtime.ensureOpen()
	if runtime.kernel.LatestRevision(taskId) != nil {
		return KernelNodeRun(runtime.kernel, taskId, nodeId, query)
	}
	return NodeRun(runtime.store, taskId, nodeId, query)
}

// NodePrompt reads the recorded prompt of one node.
func (runtime *TaskRuntime) NodePrompt(taskId, nodeId string) NodePromptView {
	runtime.ensureOpen()
	if runtime.kernel.LatestRevision(taskId) != nil {
		return KernelNodePrompt(runtime.kernel, taskId, nodeId)
	}
	return NodePromptDetail(runtime.store, taskId, nodeId)
}

// AgentWorkspace reads the workspace identity of one node.
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

// ProjectEntries reads the visible paths of one project.
func (runtime *TaskRuntime) ProjectEntries(projectId, query string, limit int) []ProjectPathEntry {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[projectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	return runtime.git.VisiblePaths(projectId, query, limit)
}

// SendNodeMessage hands a message to one node of a task.
func (runtime *TaskRuntime) SendNodeMessage(taskId, nodeId string, input NodeMessageInput) any {
	runtime.ensureOpen()
	receipt := SendKernelNodeMessage(runtime.kernel, taskId, nodeId, input, nil)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return receipt
}

// TaskRuntimePeerInput is one peer message.
type TaskRuntimePeerInput struct {
	To        string
	Text      string
	RequestId string
}

// SendPeerMessage hands a message to the peer of one node.
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
