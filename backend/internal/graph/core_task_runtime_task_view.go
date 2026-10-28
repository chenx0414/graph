package graph

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"time"

	"context"
)

// View reads the full task projection.
func (task *TaskRuntimeTask) View() map[string]any {
	runtime := task.runtime
	runtime.ensureOpen()
	current := runtime.store.Task(task.taskId)
	native := runtime.kernel.LatestRevision(task.taskId)
	rows := kernelRows(runtime.store.Db, `SELECT n.id,n.spec,n.instance_id,n.status,n.activation_id,n.output_version,n.stall_count,i.used,i.budget,i.unlimited,i.model,i.definition_version
    FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid`, task.taskId)
	invocations := runtime.taskRuntimeInvocations(task.taskId)
	unknownCost := false
	total := float64(0)
	for _, item := range invocations {
		cost, ok := jsonRecord(item["cost"])
		if !ok {
			continue
		}
		if value, ok := cost["unknown"].(bool); ok && value {
			unknownCost = true
			continue
		}
		if value, ok := cost["amount"].(float64); ok {
			total += value
		}
	}
	cost := map[string]any{"amount": total}
	if unknownCost {
		cost = map[string]any{"unknown": true}
	}
	operations := OperationSnapshots(runtime.store, task.taskId, OperationQuery{Latest: true, Limit: taskRuntimeIntPtr(50)})
	totals := kernelRows(runtime.store.Db, `SELECT node_id,COUNT(*) AS total,SUM(reserved) AS reserved,MAX(worker_active) AS active
    FROM operations WHERE task_id=? GROUP BY node_id`, task.taskId)
	operationCount := int64(0)
	for _, row := range totals {
		operationCount += kernelInt(row["total"])
	}
	questions := kernelRows(runtime.store.Db, "SELECT * FROM questions WHERE task_id=? ORDER BY rowid", task.taskId)
	userQuestions := []map[string]any{}
	for _, question := range questions {
		if kernelString(question["owner"]) == "user" {
			userQuestions = append(userQuestions, question)
		}
	}
	drafts := taskRuntimeDraftProjection(runtime.store, task.taskId, current)
	activeTask := kernelRow(runtime.store.Db, "SELECT id, project_id FROM tasks WHERE id=(SELECT active_task FROM runtime)")
	var queuedBehind any
	if current.Phase == "queued" && activeTask != nil {
		openProblems := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM questions WHERE task_id=? AND owner='main' AND status='open'", kernelString(activeTask["id"]))["count"])
		queuedBehind = map[string]any{"taskId": kernelString(activeTask["id"]), "projectId": kernelString(activeTask["project_id"]), "openProblems": openProblems}
	}
	messages := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT cursor,type,data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor", task.taskId) {
		var message map[string]any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &message); err != nil {
			panic(err)
		}
		text, _ := message["text"].(string)
		if text == "" {
			text, _ = message["request"].(string)
		}
		version := 1
		if value, ok := message["requirementVersion"].(float64); ok {
			version = int(value)
		}
		messages = append(messages, map[string]any{"cursor": kernelInt(row["cursor"]), "text": text, "requirementVersion": version})
	}
	operationList := []map[string]any{}
	for _, row := range operations {
		operationList = append(operationList, map[string]any{
			"id":           row.Id,
			"state":        row.State,
			"reserved":     row.Reserved,
			"workerActive": row.WorkerActive,
			"result":       row.Result,
		})
	}
	questionList := []map[string]any{}
	internalProblems := 0
	for _, question := range questions {
		var data any
		if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err == nil {
			questionList = append(questionList, map[string]any{
				"id":          kernelString(question["id"]),
				"nodeId":      kernelString(question["node_id"]),
				"operationId": question["operation_id"],
				"kind":        kernelString(question["kind"]),
				"status":      kernelString(question["status"]),
				"owner":       kernelString(question["owner"]),
				"data":        data,
				"answer":      nil,
			})
		}
		if kernelString(question["owner"]) == "main" && kernelString(question["status"]) == "open" {
			internalProblems++
		}
	}
	nodes := []map[string]any{}
	if native == nil {
		for _, row := range rows {
			var spec NodeSpec
			if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
				panic(err)
			}
			entry := map[string]any{
				"id":            spec.Id,
				"kind":          spec.Kind,
				"action":        spec.Action,
				"instanceId":    row["instance_id"],
				"activationId":  kernelString(row["activation_id"]),
				"outputVersion": kernelInt(row["output_version"]),
				"stallCount":    kernelInt(row["stall_count"]),
				"status":        kernelString(row["status"]),
				"used":          row["used"],
				"unlimited":     kernelInt(row["unlimited"]) != 0,
				"budget":        row["budget"],
				"reserved":      int64(0),
			}
			if row["model"] != nil {
				entry["selectedModel"] = kernelString(row["model"])
			}
			if row["definition_version"] != nil {
				entry["boundDefinition"] = kernelString(row["definition_version"])
			}
			for _, total := range totals {
				if kernelString(total["node_id"]) == spec.Id {
					entry["reserved"] = kernelInt(total["reserved"])
				}
			}
			nodes = append(nodes, entry)
		}
	}
	for _, node := range runtime.kernel.ListNodes(task.taskId) {
		spec, hasSpec := native.Definition.Nodes[node.NodeId]
		ledger := kernelRow(runtime.store.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", task.taskId, node.NodeId)
		binding := kernelRow(runtime.store.Db, "SELECT model_id FROM kernel_node_bindings WHERE task_id=? AND node_id=?", task.taskId, node.NodeId)
		model := ""
		if binding != nil && binding["model_id"] != nil {
			model = kernelString(binding["model_id"])
		}
		recipe := ""
		if hasSpec {
			recipe = spec.Recipe
		}
		used := int64(0)
		reserved := int64(0)
		if ledger != nil {
			used = kernelInt(ledger["used"])
			reserved = kernelInt(ledger["reserved"])
		}
		budget := runtime.liveBudget()
		nodes = append(nodes, map[string]any{
			"id":                node.NodeId,
			"kind":              "agent",
			"action":            node.NodeId,
			"definitionVersion": recipe,
			"model":             model,
			"instanceId":        node.InstanceId,
			"activationId":      "",
			"outputVersion":     0,
			"stallCount":        0,
			"used":              used,
			"reserved":          reserved,
			"unlimited":         budget == nil,
			"budget":            budget,
			"optional":          false,
			"boundDefinition":   recipe,
			"selectedModel":     model,
			"status":            node.Status,
			"origin":            "v2",
			"revisionVersion":   node.RevisionVersion,
		})
	}
	evidence := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT node_id,operation_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha FROM evidence WHERE task_id=? ORDER BY rowid", task.taskId) {
		var data map[string]any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		entry := map[string]any{
			"nodeId":             kernelString(row["node_id"]),
			"operationId":        kernelString(row["operation_id"]),
			"proposalVersion":    kernelInt(row["proposal_version"]),
			"requirementVersion": kernelInt(row["requirement_version"]),
			"activationId":       kernelString(row["activation_id"]),
			"valid":              kernelInt(row["valid"]) != 0,
		}
		for key, value := range data {
			entry[key] = value
		}
		if row["commit_sha"] != nil {
			entry["commitSha"] = kernelString(row["commit_sha"])
		}
		evidence = append(evidence, entry)
	}
	worktrees := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT instance_id,node_id,path,branch FROM worktrees WHERE task_id=?", task.taskId) {
		worktrees = append(worktrees, map[string]any{
			"instanceId": kernelString(row["instance_id"]),
			"nodeId":     kernelString(row["node_id"]),
			"path":       kernelString(row["path"]),
			"branch":     kernelString(row["branch"]),
		})
	}
	revisions := []map[string]any{}
	if native != nil {
		for _, row := range kernelRows(runtime.store.Db, "SELECT version,reason,version-1 AS base_version FROM kernel_revisions WHERE task_id=? ORDER BY version", task.taskId) {
			revisions = append(revisions, map[string]any{
				"version":     kernelInt(row["version"]),
				"reason":      kernelString(row["reason"]),
				"baseVersion": kernelInt(row["base_version"]),
			})
		}
	}
	graphVersion := current.GraphVersion
	if native != nil {
		graphVersion = int64(native.Version)
	}
	var currentProposal any
	if drafts.Current != nil {
		var proposal NativeProposal
		if err := json.Unmarshal([]byte(kernelString(kernelRow(runtime.store.Db, "SELECT spec FROM proposals WHERE task_id=? AND version=?", task.taskId, current.LatestProposal)["spec"])), &proposal); err == nil {
			currentProposal = proposal
		}
	}
	status := current.Phase
	if current.Paused != 0 {
		pausing := false
		if native != nil {
			pausing = KernelHasActiveWork(runtime.kernel, task.taskId)
		} else {
			for _, row := range totals {
				if kernelInt(row["active"]) != 0 {
					pausing = true
				}
			}
		}
		if pausing {
			status = "pausing"
		} else {
			status = "paused"
		}
	} else {
		for _, question := range userQuestions {
			if kernelString(question["status"]) == "open" {
				status = "blocked"
			}
		}
	}
	oldestId := any(nil)
	if len(operations) > 0 {
		oldestId = operations[0].Id
	}
	return map[string]any{
		"id":                      current.ID,
		"conversationId":          current.ConversationID,
		"projectId":               current.ProjectID,
		"request":                 current.Request,
		"requirementVersion":      current.RequirementVersion,
		"proposalVersion":         current.LatestProposal,
		"acceptedProposalVersion": current.AcceptedProposal,
		"draftRevision":           nil,
		"draftDigest":             nil,
		"graphVersion":            graphVersion,
		"proposal":                currentProposal,
		"messages":                messages,
		"containers":              []any{},
		"loops":                   []any{},
		"revisions":               revisions,
		"targetBranch":            current.TargetBranch,
		"phase":                   current.Phase,
		"paused":                  current.Paused != 0,
		"queuedBehind":            queuedBehind,
		"updatedAt":               kernelRow(runtime.store.Db, "SELECT MAX(timestamp) AS updatedAt FROM events WHERE task_id=?", task.taskId)["updatedAt"],
		"status":                  status,
		"operationHistory":        map[string]any{"total": operationCount, "limit": 50, "hasOlder": operationCount > int64(len(operations)), "oldestId": oldestId},
		"operations":              operationList,
		"questions":               questionList,
		"internalProblemCount":    internalProblems,
		"worktrees":               worktrees,
		"integrationSha":          current.IntegrationSha,
		"nodes":                   nodes,
		"evidence":                evidence,
		"invocations":             invocations,
		"cost":                    cost,
		"cursor":                  kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"]),
	}
}

func taskRuntimeIntPtr(value int) *int {
	return &value
}

// Watch streams the events of one task.
func (task *TaskRuntimeTask) Watch(after int) TaskWatch {
	runtime := task.runtime
	runtime.ensureOpen()
	if after < 0 {
		Raise("invalid_cursor", "Invalid event cursor")
	}
	stop := make(chan struct{})
	var once sync.Once
	ctx, cancel := context.WithCancel(context.Background())
	cursor := after
	pending := []TaskUpdate{}
	return TaskWatch{
		Next: func() (TaskUpdate, bool) {
			for {
				select {
				case <-stop:
					return TaskUpdate{}, false
				default:
				}
				if len(pending) > 0 {
					update := pending[0]
					pending = pending[1:]
					return update, true
				}
				wake := runtime.store.WaitForChange(ctx)
				rows := kernelRows(runtime.store.Db, "SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100", task.taskId, cursor)
				if len(rows) > 0 {
					wake.Cancel()
					for _, row := range rows {
						cursor = int(kernelInt(row["cursor"]))
						var data any
						if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
							panic(err)
						}
						pending = append(pending, TaskUpdate{
							Cursor:    cursor,
							TaskId:    task.taskId,
							Type:      kernelString(row["type"]),
							Data:      data,
							Timestamp: kernelInt(row["timestamp"]),
						})
					}
					continue
				}
				// The wake normally fires immediately; the bounded fallback
				// heals any writer that could not notify and keeps the
				// stream caught up with the database.
				select {
				case <-wake.Promise:
				case <-time.After(250 * time.Millisecond):
				case <-stop:
					return TaskUpdate{}, false
				}
				wake.Cancel()
			}
		},
		Stop: func() { once.Do(func() { close(stop); cancel() }) },
	}
}

// List reads the task list.
func (user *TaskRuntimeUser) List() []map[string]any {
	runtime := user.runtime
	runtime.ensureOpen()
	rows := kernelRows(runtime.store.Db, `SELECT t.id,t.project_id AS projectId,t.request,t.phase,t.paused,t.accepted_proposal AS acceptedProposalVersion,
    t.conversation_id AS conversationId,
    (SELECT MIN(timestamp) FROM events WHERE task_id=t.id) AS createdAt,
    (SELECT MAX(timestamp) FROM events WHERE task_id=t.id) AS updatedAt,
    (SELECT COUNT(*) FROM questions WHERE task_id=t.id AND status='open' AND owner='user') AS openQuestions
    FROM tasks t WHERE t.phase!='chatting' ORDER BY t.created_seq`)
	out := []map[string]any{}
	for _, row := range rows {
		status := kernelString(row["phase"])
		switch {
		case kernelInt(row["paused"]) != 0:
			status = "paused"
		case kernelInt(row["openQuestions"]) > 0:
			status = "blocked"
		}
		out = append(out, map[string]any{
			"id":                      kernelString(row["id"]),
			"projectId":               kernelString(row["projectId"]),
			"request":                 kernelString(row["request"]),
			"phase":                   kernelString(row["phase"]),
			"conversationId":          row["conversationId"],
			"status":                  status,
			"acceptedProposalVersion": row["acceptedProposalVersion"],
			"createdAt":               row["createdAt"],
			"updatedAt":               row["updatedAt"],
			"openQuestions":           kernelInt(row["openQuestions"]),
		})
	}
	return out
}

// Projects reads the configured projects with their preparation state.
func (user *TaskRuntimeUser) Projects() []map[string]any {
	runtime := user.runtime
	runtime.ensureOpen()
	out := []map[string]any{}
	for _, project := range runtime.configuredProjects() {
		root, err := filepath.Abs(project.Root)
		if err != nil {
			root = project.Root
		}
		entry := map[string]any{
			"id":          project.Id,
			"root":        root,
			"grants":      taskRuntimeGrants(project.Grants),
			"branch":      nil,
			"archivedAt":  projectArchivedAt(runtime.store, project.Id),
			"preparation": runtime.git.Preparation(project.Id),
		}
		if branch := CheckedOutBranch(root); branch != nil {
			entry["branch"] = *branch
		}
		out = append(out, entry)
	}
	return out
}

// Events reads the events of one task.
func (runtime *TaskRuntime) Events(taskId string, after int, limit int) []TaskUpdate {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	cap := limit
	if cap <= 0 {
		cap = 200
	}
	if cap > 500 {
		cap = 500
	}
	out := []TaskUpdate{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT ?", taskId, after, cap) {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		out = append(out, TaskUpdate{
			Cursor:    int(kernelInt(row["cursor"])),
			TaskId:    taskId,
			Type:      kernelString(row["type"]),
			Data:      data,
			Timestamp: kernelInt(row["timestamp"]),
		})
	}
	return out
}

// Operations reads the operations of one task.
func (runtime *TaskRuntime) Operations(taskId string, query OperationQuery) []map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	limit := 50
	if query.Limit != nil && *query.Limit > 0 {
		limit = *query.Limit
		if limit > 100 {
			limit = 100
		}
	}
	scoped := query
	scoped.Limit = &limit
	rows := OperationSnapshots(runtime.store, taskId, scoped)
	out := []map[string]any{}
	for _, row := range rows {
		entry := map[string]any{
			"id":           row.Id,
			"state":        row.State,
			"reserved":     row.Reserved,
			"workerActive": row.WorkerActive,
			"result":       row.Result,
		}
		if row.DispatchedAt != nil {
			entry["startedAt"] = *row.DispatchedAt
		}
		if row.SettledAt != nil {
			entry["endedAt"] = *row.SettledAt
			duration := *row.SettledAt
			if row.DispatchedAt != nil {
				duration -= *row.DispatchedAt
			}
			entry["durationMs"] = duration
		}
		out = append(out, entry)
	}
	return out
}
