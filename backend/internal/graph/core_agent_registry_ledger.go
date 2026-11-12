package graph

import (
	"database/sql"
	"encoding/json"
)

type fleetUsageAgg struct {
	tokens    int64
	requests  int64
	cost      float64
	updatedAt int64
}

type fleetActive struct {
	operationId string
	action      string
}

type fleetLedger struct {
	messages           map[string]fleetUsageAgg
	supervisorUsage    map[string]fleetUsageAgg
	nodeUsage          map[string]fleetUsageAgg
	nodeMessages       map[string]fleetUsageAgg
	nodeStatus         map[string]string
	nodeModel          map[string]string
	masterModel        map[string]string
	kernelExecution    map[string]string
	activeConversation map[string]fleetActive
	activeNode         map[string]fleetActive
	openQuestions      map[string]int64
	taskPhase          map[string]string
	taskConversation   map[string]string
	taskProject        map[string]string
	taskRequest        map[string]string
}

func fleetKey(taskId, nodeId string) string {
	return taskId + "\x00" + nodeId
}

func graphTableExists(db *sql.DB, table string) bool {
	var name string
	err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
	return err == nil
}

func fleetUsageRow(row map[string]any) fleetUsageAgg {
	return fleetUsageAgg{
		tokens: kernelInt(row["tokens"]), requests: kernelInt(row["requests"]),
		cost: kernelFloat(row["cost"]), updatedAt: kernelInt(row["updatedAt"]),
	}
}

func loadFleetLedger(store *TaskStore) *fleetLedger {
	ledger := &fleetLedger{
		messages: map[string]fleetUsageAgg{}, supervisorUsage: map[string]fleetUsageAgg{},
		nodeUsage: map[string]fleetUsageAgg{}, nodeMessages: map[string]fleetUsageAgg{},
		nodeStatus: map[string]string{}, nodeModel: map[string]string{}, masterModel: map[string]string{},
		kernelExecution: map[string]string{}, activeConversation: map[string]fleetActive{},
		activeNode: map[string]fleetActive{}, openQuestions: map[string]int64{},
		taskPhase: map[string]string{}, taskConversation: map[string]string{},
		taskProject: map[string]string{}, taskRequest: map[string]string{},
	}
	for _, row := range kernelRows(store.Db, `SELECT conversation_id,COUNT(*) AS messages,MAX(updated_at) AS updatedAt
		FROM messages GROUP BY conversation_id`) {
		ledger.messages[kernelString(row["conversation_id"])] = fleetUsageAgg{
			requests: kernelInt(row["messages"]), updatedAt: kernelInt(row["updatedAt"]),
		}
	}
	for _, row := range kernelRows(store.Db, `SELECT t.conversation_id AS conversationId,COUNT(*) AS requests,
		COALESCE(SUM(COALESCE(CAST(json_extract(i.usage,'$.input') AS INTEGER),0)
			+ COALESCE(CAST(json_extract(i.usage,'$.output') AS INTEGER),0)
			+ COALESCE(CAST(json_extract(i.usage,'$.cacheRead') AS INTEGER),0)
			+ COALESCE(CAST(json_extract(i.usage,'$.cacheWrite') AS INTEGER),0)),0) AS tokens,
		COALESCE(SUM(CAST(json_extract(i.cost,'$.amount') AS REAL)),0) AS cost,
		MAX(COALESCE(i.settled_at,i.dispatched_at,0)) AS updatedAt
		FROM invocations i JOIN operations o ON o.id=i.operation_id JOIN tasks t ON t.id=o.task_id
		WHERE t.conversation_id IS NOT NULL AND EXISTS(SELECT 1 FROM nodes n WHERE n.task_id=o.task_id
			AND n.id=o.node_id AND json_extract(n.spec,'$.role')='master')
		GROUP BY t.conversation_id`) {
		ledger.supervisorUsage[kernelString(row["conversationId"])] = fleetUsageRow(row)
	}
	for _, row := range kernelRows(store.Db, `SELECT o.task_id AS taskId,o.node_id AS nodeId,COUNT(*) AS requests,
		COALESCE(SUM(COALESCE(CAST(json_extract(i.usage,'$.input') AS INTEGER),0)
			+ COALESCE(CAST(json_extract(i.usage,'$.output') AS INTEGER),0)
			+ COALESCE(CAST(json_extract(i.usage,'$.cacheRead') AS INTEGER),0)
			+ COALESCE(CAST(json_extract(i.usage,'$.cacheWrite') AS INTEGER),0)),0) AS tokens,
		COALESCE(SUM(CAST(json_extract(i.cost,'$.amount') AS REAL)),0) AS cost,
		MAX(COALESCE(i.settled_at,i.dispatched_at,0)) AS updatedAt
		FROM invocations i JOIN operations o ON o.id=i.operation_id
		GROUP BY o.task_id,o.node_id`) {
		ledger.nodeUsage[fleetKey(kernelString(row["taskId"]), kernelString(row["nodeId"]))] = fleetUsageRow(row)
	}
	for _, row := range kernelRows(store.Db, `SELECT task_id,node_id,COUNT(*) AS messages,MAX(created_at) AS updatedAt
		FROM node_entries GROUP BY task_id,node_id`) {
		key := fleetKey(kernelString(row["task_id"]), kernelString(row["node_id"]))
		ledger.nodeMessages[key] = fleetUsageAgg{requests: kernelInt(row["messages"]), updatedAt: kernelInt(row["updatedAt"])}
	}
	for _, row := range kernelRows(store.Db, `SELECT task_id,id,status,spec,instance_id FROM nodes WHERE id!='master'`) {
		key := fleetKey(kernelString(row["task_id"]), kernelString(row["id"]))
		ledger.nodeStatus[key] = kernelString(row["status"])
		if model := jsonText(kernelString(row["spec"]), "model"); model != "" {
			ledger.nodeModel[key] = model
		} else if row["instance_id"] != nil {
			if instance := kernelRow(store.Db, "SELECT model FROM instances WHERE id=?", kernelString(row["instance_id"])); instance != nil {
				ledger.nodeModel[key] = kernelString(instance["model"])
			}
		}
		if action := jsonText(kernelString(row["spec"]), "action"); action != "" {
			ledger.nodeModel["\x00action"+key] = action
		}
	}
	for _, row := range kernelRows(store.Db, "SELECT task_id,spec FROM nodes WHERE id='master'") {
		ledger.masterModel[kernelString(row["task_id"])] = jsonText(kernelString(row["spec"]), "model")
	}
	if graphTableExists(store.Db, "kernel_nodes") {
		for _, row := range kernelRows(store.Db, "SELECT task_id,node_id,status,spec FROM kernel_nodes") {
			key := fleetKey(kernelString(row["task_id"]), kernelString(row["node_id"]))
			if _, exists := ledger.nodeStatus[key]; !exists {
				ledger.nodeStatus[key] = kernelString(row["status"])
			}
			if model := jsonText(kernelString(row["spec"]), "model"); model != "" {
				if _, exists := ledger.nodeModel[key]; !exists {
					ledger.nodeModel[key] = model
				}
			}
		}
		for _, row := range kernelRows(store.Db, `SELECT task_id,node_id,id FROM kernel_executions
			WHERE state='running' ORDER BY rowid`) {
			ledger.kernelExecution[fleetKey(kernelString(row["task_id"]), kernelString(row["node_id"]))] = kernelString(row["id"])
		}
		for _, row := range kernelRows(store.Db, `SELECT task_id,node_id,COUNT(*) AS requests,
			COALESCE(SUM(COALESCE(CAST(json_extract(usage,'$.input') AS INTEGER),0)
				+ COALESCE(CAST(json_extract(usage,'$.output') AS INTEGER),0)
				+ COALESCE(CAST(json_extract(usage,'$.cacheRead') AS INTEGER),0)
				+ COALESCE(CAST(json_extract(usage,'$.cacheWrite') AS INTEGER),0)),0) AS tokens,
			COALESCE(SUM(CAST(json_extract(cost,'$.amount') AS REAL)),0) AS cost,
			MAX(COALESCE(settled_at,created_at,0)) AS updatedAt
			FROM kernel_provider_calls GROUP BY task_id,node_id`) {
			key := fleetKey(kernelString(row["task_id"]), kernelString(row["node_id"]))
			aggregate := ledger.nodeUsage[key]
			usage := fleetUsageRow(row)
			aggregate.tokens += usage.tokens
			aggregate.requests += usage.requests
			aggregate.cost += usage.cost
			if usage.updatedAt > aggregate.updatedAt {
				aggregate.updatedAt = usage.updatedAt
			}
			ledger.nodeUsage[key] = aggregate
		}
	}
	for _, row := range kernelRows(store.Db, `SELECT o.task_id AS taskId,o.node_id AS nodeId,o.id AS operationId,o.spec AS spec
		FROM operations o WHERE o.worker_active=1 ORDER BY o.rowid`) {
		key := fleetKey(kernelString(row["taskId"]), kernelString(row["nodeId"]))
		ledger.activeNode[key] = fleetActive{operationId: kernelString(row["operationId"]), action: jsonText(kernelString(row["spec"]), "action")}
	}
	for _, row := range kernelRows(store.Db, `SELECT id,project_id,conversation_id,phase,request FROM tasks`) {
		taskId := kernelString(row["id"])
		ledger.taskPhase[taskId] = kernelString(row["phase"])
		ledger.taskConversation[taskId] = kernelString(row["conversation_id"])
		ledger.taskProject[taskId] = kernelString(row["project_id"])
		ledger.taskRequest[taskId] = kernelString(row["request"])
	}
	for _, row := range kernelRows(store.Db, `SELECT t.conversation_id AS conversationId,COUNT(*) AS questions
		FROM questions q JOIN tasks t ON t.id=q.task_id WHERE q.status='open' AND t.conversation_id IS NOT NULL
		GROUP BY t.conversation_id`) {
		ledger.openQuestions[kernelString(row["conversationId"])] = kernelInt(row["questions"])
	}
	for taskId, conversationId := range ledger.taskConversation {
		if conversationId == "" {
			continue
		}
		active, ok := ledger.activeNode[fleetKey(taskId, "master")]
		if !ok {
			continue
		}
		ledger.activeConversation[conversationId] = active
	}
	return ledger
}

func (ledger *fleetLedger) agentUsage(agent AgentRecord) fleetUsageAgg {
	usage := fleetUsageAgg{}
	switch agent.Kind {
	case "global", "project", "child":
		conversationId := agent.ConversationId
		if conversationId == "" {
			conversationId = agent.Id
		}
		if messages, ok := ledger.messages[conversationId]; ok {
			if messages.updatedAt > usage.updatedAt {
				usage.updatedAt = messages.updatedAt
			}
		}
		if supervisor, ok := ledger.supervisorUsage[conversationId]; ok {
			usage.tokens += supervisor.tokens
			usage.requests += supervisor.requests
			usage.cost += supervisor.cost
			if supervisor.updatedAt > usage.updatedAt {
				usage.updatedAt = supervisor.updatedAt
			}
		}
	case "node":
		key := fleetKey(agent.TaskId, agent.NodeId)
		if node, ok := ledger.nodeUsage[key]; ok {
			usage.tokens += node.tokens
			usage.requests += node.requests
			usage.cost += node.cost
			if node.updatedAt > usage.updatedAt {
				usage.updatedAt = node.updatedAt
			}
		}
		if messages, ok := ledger.nodeMessages[key]; ok {
			if messages.updatedAt > usage.updatedAt {
				usage.updatedAt = messages.updatedAt
			}
		}
	}
	return usage
}

func (ledger *fleetLedger) agentMessages(agent AgentRecord) int64 {
	switch agent.Kind {
	case "global", "project", "child":
		conversationId := agent.ConversationId
		if conversationId == "" {
			conversationId = agent.Id
		}
		return ledger.messages[conversationId].requests
	case "node":
		return ledger.nodeMessages[fleetKey(agent.TaskId, agent.NodeId)].requests
	}
	return 0
}

func (ledger *fleetLedger) agentStatus(agent AgentRecord) string {
	switch agent.Kind {
	case "node":
		key := fleetKey(agent.TaskId, agent.NodeId)
		if ledger.activeNode[key].operationId != "" || ledger.kernelExecution[key] != "" {
			return "running"
		}
		status := ledger.nodeStatus[key]
		switch status {
		case "running":
			return "running"
		case "blocked":
			return "blocked"
		case "failed":
			return "failed"
		case "succeeded", "skipped", "retired":
			return "done"
		}
		switch ledger.taskPhase[agent.TaskId] {
		case "completed":
			return "done"
		case "abandoned", "stopped", "stopping":
			return "stopped"
		case "blocked":
			return "blocked"
		}
		return "idle"
	default:
		conversationId := agent.ConversationId
		if conversationId == "" {
			conversationId = agent.Id
		}
		if ledger.activeConversation[conversationId].operationId != "" {
			return "running"
		}
		if ledger.openQuestions[conversationId] > 0 {
			return "blocked"
		}
		if agent.ClosedAt != nil {
			return "done"
		}
		switch ledger.taskPhase[agent.TaskId] {
		case "blocked":
			return "blocked"
		case "completed":
			return "done"
		case "abandoned", "stopped", "stopping":
			return "stopped"
		}
		return "idle"
	}
}

func (ledger *fleetLedger) agentCurrentOperation(agent AgentRecord) (string, string) {
	switch agent.Kind {
	case "node":
		key := fleetKey(agent.TaskId, agent.NodeId)
		if active := ledger.activeNode[key]; active.operationId != "" {
			return active.operationId, active.action
		}
		if execution := ledger.kernelExecution[key]; execution != "" {
			return execution, ""
		}
	case "global", "project", "child":
		conversationId := agent.ConversationId
		if conversationId == "" {
			conversationId = agent.Id
		}
		if active := ledger.activeConversation[conversationId]; active.operationId != "" {
			return active.operationId, active.action
		}
	}
	return "", ""
}

func (ledger *fleetLedger) agentModel(agent AgentRecord) string {
	if agent.Kind == "node" {
		if model := ledger.nodeModel[fleetKey(agent.TaskId, agent.NodeId)]; model != "" {
			return model
		}
	}
	if agent.Kind == "global" || agent.Kind == "project" {
		if model := ledger.masterModel[agent.TaskId]; model != "" {
			return model
		}
	}
	return agent.Model
}

func kernelFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int64:
		return float64(typed)
	case int:
		return float64(typed)
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0
		}
		return number
	default:
		return 0
	}
}

func jsonText(raw, key string) string {
	if raw == "" {
		return ""
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return ""
	}
	value, _ := record[key].(string)
	return value
}
