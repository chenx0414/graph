package graph

import (
	"strings"

	"encoding/json"
)

func (e *Execution) startRun(node ExecutionNodeRow) {
	go func() {
		_, _ = e.run(node)
	}()
}

func (e *Execution) run(node ExecutionNodeRow) (bool, any) {
	e.mu.Lock()
	e.running++
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.running--
		e.mu.Unlock()
		e.notifyWork()
	}()
	return e.runGuardedBool(func() bool {
		return e.execute(node)
	})
}

func (e *Execution) runGuardedBool(action func() bool) (result bool, failure any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = recovered
			result = false
		}
	}()
	return action(), nil
}

func (e *Execution) laneTasks() []string {
	rows := kernelRows(e.store.Db, `SELECT t.id FROM tasks t
      LEFT JOIN conversations c ON c.id=t.conversation_id
      WHERE t.phase='chatting' AND c.archived_at IS NULL
      ORDER BY t.created_seq`)
	chatting := []string{}
	for _, row := range rows {
		chatting = append(chatting, kernelString(row["id"]))
	}
	active := kernelString(kernelRow(e.store.Db, "SELECT active_task FROM runtime")["active_task"])
	if active != "" && !containsString(chatting, active) && e.store.Task(active).Phase != "chatting" {
		chatting = append(chatting, active)
	}
	return chatting
}

func (e *Execution) nodeSpec(node ExecutionNodeRow) NodeSpec {
	var spec NodeSpec
	if err := json.Unmarshal([]byte(node.Spec), &spec); err != nil {
		panic(err)
	}
	return spec
}

func (e *Execution) refreshDefinition(node ExecutionNodeRow) ExecutionNodeRow {
	spec := e.nodeSpec(node)
	id := ""
	if spec.DefinitionVersion != nil {
		id = strings.Split(*spec.DefinitionVersion, "@")[0]
	}
	definitionVersion := ""
	if id != "" && e.catalog != nil {
		definitions := e.catalog.ListDefinitions()
		found := false
		var version int64
		for _, item := range definitions {
			if item.Id != id {
				continue
			}
			if !found || item.Version > version {
				found = true
				version = item.Version
			}
		}
		if found {
			definitionVersion = id + "@" + itoa(int(version))
		}
	}
	if definitionVersion == "" {
		return node
	}
	if spec.DefinitionVersion != nil && definitionVersion == *spec.DefinitionVersion {
		return node
	}
	spec.DefinitionVersion = &definitionVersion
	specText := CanonicalJSON(spec)
	e.store.SetNodeSpec(node.TaskId, node.Id, specText)
	if node.InstanceId != nil {
		e.store.SetInstanceDefinition(*node.InstanceId, &definitionVersion)
	}
	node.Spec = specText
	return node
}

func (e *Execution) readyNodes() []ExecutionNodeRow {
	if e.stopping || (e.dispatchAllowed != nil && !e.dispatchAllowed()) {
		return nil
	}
	graphDatabaseMu.Lock()
	defer graphDatabaseMu.Unlock()
	nodes := []ExecutionNodeRow{}
	for _, taskId := range e.laneTasks() {
		if e.store.Task(taskId).Paused != 0 {
			continue
		}
		nodes = append(nodes, e.readyNodesFor(taskId)...)
	}
	return nodes
}

func (e *Execution) readyNodesFor(taskId string) []ExecutionNodeRow {
	task := e.store.Task(taskId)
	if task.Phase == "chatting" {
		conversation := ConversationForTask(e.store, taskId)
		if conversation == nil || conversation.ArchivedAt != nil || conversation.Role == ConversationHistory {
			return nil
		}
		if kernelInt(kernelRow(e.store.Db, "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", conversation.Id)["count"]) == 0 &&
			kernelRow(e.store.Db, "SELECT id FROM wake_intents WHERE task_id=? AND state='ready' LIMIT 1", taskId) == nil {
			return nil
		}
		busy := kernelRow(e.store.Db, "SELECT id FROM operations WHERE task_id=? AND state IN ('dispatched','unknown') LIMIT 1", taskId) != nil
		stranded := kernelRow(e.store.Db, "SELECT id FROM messages WHERE conversation_id=? AND state IN ('pending','queued') LIMIT 1", conversation.Id) != nil
		rows := kernelRows(e.store.Db, `SELECT * FROM nodes n
        WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'
        AND (n.status='pending' OR (n.status='blocked' AND EXISTS(
          SELECT 1 FROM questions q WHERE q.task_id=n.task_id AND q.node_id=n.id AND q.status='open' AND q.owner='main')))
        ORDER BY n.rowid`, taskId)
		out := []ExecutionNodeRow{}
		for _, row := range rows {
			node := executionNodeRowOf(row)
			if (busy || !stranded) && kernelString(row["status"]) == "blocked" {
				continue
			}
			if IsMasterParked(e.store, taskId, node.Id) {
				continue
			}
			if task.Paused != 0 && PendingRsiContinuation(e.store, taskId, node.Id) != nil {
				continue
			}
			out = append(out, node)
		}
		return out
	}
	if task.Phase != "discussing" {
		return nil
	}
	rows := kernelRows(e.store.Db, "SELECT * FROM nodes WHERE task_id=? AND status='pending' AND json_extract(spec,'$.role')='master' ORDER BY rowid", taskId)
	out := []ExecutionNodeRow{}
	for _, row := range rows {
		out = append(out, executionNodeRowOf(row))
	}
	return out
}

func executionNodeRowOf(row map[string]any) ExecutionNodeRow {
	node := ExecutionNodeRow{
		Id:           kernelString(row["id"]),
		TaskId:       kernelString(row["task_id"]),
		Spec:         kernelString(row["spec"]),
		Status:       kernelString(row["status"]),
		ActivationId: kernelString(row["activation_id"]),
	}
	if row["instance_id"] != nil {
		value := kernelString(row["instance_id"])
		node.InstanceId = &value
	}
	if row["output"] != nil {
		value := kernelString(row["output"])
		node.Output = &value
	}
	return node
}
