package graph

import (
	"sort"
	"strconv"
	"strings"
)

func fleetEventText(eventType string, data map[string]any) string {
	for _, key := range []string{"text", "reason", "summary", "title", "request"} {
		if value := fleetDataString(data, key); strings.TrimSpace(value) != "" {
			return fleetTruncateText(value, 200)
		}
	}
	if message := fleetDataRecord2(data, "message"); message != nil {
		if value := fleetDataString(message, "text"); strings.TrimSpace(value) != "" {
			return fleetTruncateText(value, 200)
		}
	}
	return ""
}

func fleetDataRecord2(data map[string]any, key string) map[string]any {
	value, _ := data[key].(map[string]any)
	return value
}

func fleetMessageSource(data map[string]any) map[string]any {
	message := fleetDataRecord2(data, "message")
	if message == nil {
		return nil
	}
	inner := fleetDataRecord2(message, "data")
	if inner == nil {
		return nil
	}
	return fleetDataRecord2(inner, "source")
}

func fleetEventSender(data map[string]any, index fleetAgentIndex) string {
	source := fleetMessageSource(data)
	if source == nil {
		return ""
	}
	if conversationId := fleetDataString(source, "conversationId"); conversationId != "" {
		if agent := index.byConversation[conversationId]; agent != "" {
			return agent
		}
	}
	return ""
}

func fleetTruncateText(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return string(runes)
}

func fleetTaskTitle(text string) string {
	if index := strings.IndexAny(text, "\r\n"); index >= 0 {
		text = text[:index]
	}
	return fleetTruncateText(text, 120)
}

func fleetTasks(store *TaskStore, scope fleetScope, scoped []AgentRecord) ([]FleetTask, map[string]bool) {
	taskSet := map[string]bool{}
	if !scope.global {
		taskSet[scope.anchorTaskId] = true
		for _, agent := range scoped {
			if agent.TaskId != "" {
				taskSet[agent.TaskId] = true
			}
		}
	}
	taskTimes := map[string][2]int64{}
	for _, row := range kernelRows(store.Db, `SELECT task_id,MIN(timestamp) AS startedAt,MAX(timestamp) AS updatedAt
		FROM events WHERE task_id IS NOT NULL GROUP BY task_id`) {
		taskTimes[kernelString(row["task_id"])] = [2]int64{kernelInt(row["startedAt"]), kernelInt(row["updatedAt"])}
	}
	conversationAgents := map[string]bool{}
	for _, agent := range scoped {
		if agent.Kind == "global" || agent.Kind == "project" {
			conversationId := agent.ConversationId
			if conversationId == "" {
				conversationId = agent.Id
			}
			conversationAgents[conversationId] = true
		}
	}
	out := []FleetTask{}
	for _, row := range kernelRows(store.Db, `SELECT id,project_id,conversation_id,phase,request FROM tasks
		WHERE phase!='chatting' AND archived_at IS NULL AND deleted_at IS NULL`) {
		taskId := kernelString(row["id"])
		if !scope.global && !taskSet[taskId] {
			continue
		}
		times := taskTimes[taskId]
		owner := kernelString(row["conversation_id"])
		if !conversationAgents[owner] {
			owner = ""
		}
		out = append(out, FleetTask{
			Id: taskId, Title: kernelString(row["request"]), Status: kernelString(row["phase"]),
			Phase: kernelString(row["phase"]), OwnerAgentId: owner, ProjectId: kernelString(row["project_id"]),
			TaskId: taskId, StartedAt: times[0], UpdatedAt: times[1],
		})
	}
	workQuery := `SELECT w.id,w.conversation_id,w.project_id,w.state,w.created_at,w.updated_at,r.brief
		FROM work_requests w LEFT JOIN work_request_revisions r ON r.work_id=w.id AND r.revision=w.revision`
	workArgs := []any{}
	if !scope.global {
		workQuery += " WHERE w.conversation_id=?"
		workArgs = append(workArgs, scope.conversationId)
	}
	workQuery += " ORDER BY w.updated_at DESC,w.id"
	for _, row := range kernelRows(store.Db, workQuery, workArgs...) {
		owner := kernelString(row["conversation_id"])
		if !conversationAgents[owner] {
			owner = ""
		}
		out = append(out, FleetTask{
			Id: kernelString(row["id"]), Title: fleetTaskTitle(kernelString(row["brief"])),
			Status: kernelString(row["state"]), Phase: kernelString(row["state"]), OwnerAgentId: owner,
			ProjectId: kernelString(row["project_id"]), StartedAt: kernelInt(row["created_at"]),
			UpdatedAt: kernelInt(row["updated_at"]),
		})
	}
	sort.SliceStable(out, func(left, right int) bool {
		if out[left].UpdatedAt != out[right].UpdatedAt {
			return out[left].UpdatedAt > out[right].UpdatedAt
		}
		return out[left].Id < out[right].Id
	})
	return out, taskSet
}

func fleetEvents(store *TaskStore, scope fleetScope, taskSet map[string]bool, index fleetAgentIndex) ([]FleetEvent, bool) {
	query := "SELECT cursor,task_id,type,data,timestamp FROM events"
	args := []any{}
	if !scope.global {
		query += ` WHERE task_id IS NOT NULL AND task_id IN
			(SELECT id FROM tasks WHERE project_id=? OR conversation_id=? OR id=?)`
		args = append(args, scope.projectId, scope.conversationId, scope.anchorTaskId)
	}
	query += " ORDER BY cursor DESC LIMIT " + strconv.Itoa(fleetEventLimit+1)
	rows := kernelRows(store.Db, query, args...)
	truncated := len(rows) > fleetEventLimit
	if truncated {
		rows = rows[:fleetEventLimit]
	}
	if extra := fleetCrossAgentRows(store, scope, rows); len(extra) > 0 {
		room := fleetEventLimit - len(extra)
		if room < 0 {
			room = 0
		}
		if len(rows) > room {
			rows = rows[:room]
			truncated = true
		}
		rows = append(rows, extra...)
	}
	out := make([]FleetEvent, 0, len(rows))
	for _, row := range rows {
		taskId := kernelString(row["task_id"])
		if !scope.global && !taskSet[taskId] {
			continue
		}
		data := fleetDataRecord(kernelString(row["data"]))
		eventType := kernelString(row["type"])
		agentId := index.agentForEvent(taskId, data)
		targetId := index.targetForEvent(taskId, data)
		senderId := ""
		if strings.HasPrefix(eventType, "message.") {
			senderId = fleetEventSender(data, index)
			if senderId == agentId {
				senderId = ""
			}
		}
		out = append(out, FleetEvent{
			Id: strconv.FormatInt(kernelInt(row["cursor"]), 10), At: kernelInt(row["timestamp"]),
			Type: eventType, AgentId: agentId,
			TargetAgentId: targetId, SenderAgentId: senderId, TaskId: taskId,
			Text: fleetEventText(eventType, data),
		})
	}
	return out, truncated
}

func fleetArtifacts(store *TaskStore, scope fleetScope, taskSet map[string]bool, index fleetAgentIndex) ([]FleetArtifact, bool) {
	query := `SELECT artifact_id,task_id,namespace,name,title,media_type,version,size,producer_node_id,created_at
		FROM artifacts`
	args := []any{}
	if !scope.global {
		query += ` WHERE task_id IN (SELECT id FROM tasks WHERE project_id=? OR conversation_id=? OR id=?)`
		args = append(args, scope.projectId, scope.conversationId, scope.anchorTaskId)
	}
	query += " ORDER BY created_at DESC,artifact_id DESC LIMIT " + strconv.Itoa(fleetArtifactLimit+1)
	rows := kernelRows(store.Db, query, args...)
	truncated := len(rows) > fleetArtifactLimit
	if truncated {
		rows = rows[:fleetArtifactLimit]
	}
	out := make([]FleetArtifact, 0, len(rows))
	for _, row := range rows {
		taskId := kernelString(row["task_id"])
		if !scope.global && !taskSet[taskId] {
			continue
		}
		producer := ""
		if nodeId := kernelString(row["producer_node_id"]); nodeId != "" {
			producer = index.byTaskNode[fleetKey(taskId, nodeId)]
		}
		if producer == "" {
			producer = index.byTask[taskId]
		}
		out = append(out, FleetArtifact{
			ArtifactId: kernelString(row["artifact_id"]), TaskId: taskId,
			Namespace: kernelString(row["namespace"]), Name: kernelString(row["name"]),
			Title: kernelString(row["title"]), MediaType: kernelString(row["media_type"]),
			Version: kernelInt(row["version"]), Size: kernelInt(row["size"]),
			ProducerAgentId: producer, ProducerTaskId: taskId, CreatedAt: kernelInt(row["created_at"]),
		})
	}
	return out, truncated
}

func fleetAgentOf(ledger *fleetLedger, agent AgentRecord) FleetAgent {
	usage := ledger.agentUsage(agent)
	currentOperationId, activity := ledger.agentCurrentOperation(agent)
	updatedAt := usage.updatedAt
	if agent.ClosedAt != nil && *agent.ClosedAt > updatedAt {
		updatedAt = *agent.ClosedAt
	}
	return FleetAgent{
		Id: agent.Id, ParentId: agent.ParentId, Kind: agent.Kind, Role: agent.Role, Name: agent.Name,
		Model: ledger.agentModel(agent), ProjectId: agent.ProjectId, ConversationId: agent.ConversationId,
		TaskId: agent.TaskId, NodeId: agent.NodeId, Status: ledger.agentStatus(agent), Activity: activity,
		Tokens: usage.tokens, Cost: usage.cost, Requests: usage.requests, Messages: ledger.agentMessages(agent),
		CreatedAt: agent.CreatedAt, UpdatedAt: updatedAt, CurrentOperationId: currentOperationId,
	}
}

// fleetCrossAgentRows keeps the agent-to-agent events a long run can push out
// of the recent window. The card draws arrows only where a sender differs from
// its receiver, so losing every one of them to a busy tool log hides the
// collaboration entirely.
func fleetCrossAgentRows(store *TaskStore, scope fleetScope, recent []map[string]any) []map[string]any {
	if len(recent) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(recent))
	oldest := int64(1 << 62)
	for _, row := range recent {
		seen[kernelString(row["task_id"])+"#"+strconv.FormatInt(kernelInt(row["cursor"]), 10)] = true
		if cursor := kernelInt(row["cursor"]); cursor < oldest {
			oldest = cursor
		}
	}
	query := "SELECT cursor,task_id,type,data,timestamp FROM events WHERE cursor < ? AND (data LIKE '%sourceConversationId%' OR (type='message.created' AND data LIKE '%\"source\":{%'))"
	args := []any{oldest}
	if !scope.global {
		query += ` AND task_id IS NOT NULL AND task_id IN
			(SELECT id FROM tasks WHERE project_id=? OR conversation_id=? OR id=?)`
		args = append(args, scope.projectId, scope.conversationId, scope.anchorTaskId)
	}
	query += " ORDER BY cursor DESC LIMIT " + strconv.Itoa(fleetEventLimit)
	extra := []map[string]any{}
	for _, row := range kernelRows(store.Db, query, args...) {
		key := kernelString(row["task_id"]) + "#" + strconv.FormatInt(kernelInt(row["cursor"]), 10)
		if seen[key] {
			continue
		}
		extra = append(extra, row)
	}
	return extra
}
