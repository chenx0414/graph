package graph

import "strings"

type AgentControlInput struct {
	Action    string
	AgentId   string
	SinceSeq  *int
	Limit     int
	AfterId   string
	Text      string
	Reason    string
	RequestId string
}

func (runtime *TaskRuntime) ControlAgent(parent AgentSpawnParent, input AgentControlInput) any {
	runtime.ensureOpen()
	targetID := strings.TrimSpace(input.AgentId)
	if input.Action == "list_children" && targetID == "" {
		targetID = parent.AgentId
	}
	target := runtime.agentControlTarget(parent.AgentId, targetID, input.Action == "list_children")
	switch input.Action {
	case "read_agent":
		return runtime.readAgent(target, input)
	case "list_children":
		return runtime.listAgentChildren(target, input)
	case "message_agent":
		runtime.requireAgentProjectActive(target)
		if target.ClosedAt != nil {
			Raise("invalid_state", "The Agent is closed")
		}
		if target.Kind == "node" {
			result := SendKernelNodeMessage(runtime.kernel, target.TaskId, target.NodeId, NodeMessageInput{Text: input.Text, RequestID: parent.AgentId + ":" + input.RequestId}, nil)
			if runtime.autoWake {
				runtime.execution.Kick()
			}
			return result
		}
		return runtime.Conversations().Chat(target.ConversationId, TaskRuntimeChatInput{
			Text: input.Text, RequestId: "agent:" + parent.AgentId + ":" + input.RequestId,
			Source: map[string]any{"kind": "agent", "agentId": parent.AgentId},
		})
	case "stop_agent":
		if target.Kind == "node" {
			return runtime.stopGraphNode(parent.AgentId, target.TaskId, target.NodeId, input.RequestId)
		}
		receipt := runtime.Conversations().Pause(target.ConversationId, "agent:"+parent.AgentId+":"+input.RequestId)
		return map[string]any{"agentId": target.Id, "paused": true, "receipt": receipt}
	default:
		Raise("invalid_input", "Unknown Agent control action")
	}
	return nil
}

func (runtime *TaskRuntime) agentControlTarget(callerID, targetID string, allowSelf bool) AgentRecord {
	caller := AgentById(runtime.store, callerID)
	target := AgentById(runtime.store, targetID)
	if caller == nil || target == nil {
		Raise("not_found", "Agent not found")
	}
	if allowSelf && callerID == targetID {
		return *target
	}
	visited := map[string]bool{}
	for id := target.ParentId; id != "" && !visited[id]; {
		if id == callerID {
			return *target
		}
		visited[id] = true
		agent := AgentById(runtime.store, id)
		if agent == nil {
			break
		}
		id = agent.ParentId
	}
	Raise("permission", "Only a descendant Agent may be accessed")
	return AgentRecord{}
}

func (runtime *TaskRuntime) requireAgentProjectActive(agent AgentRecord) {
	if agent.ProjectId != "" && kernelRow(runtime.store.Db, "SELECT 1 FROM projects WHERE id=? AND archived_at IS NOT NULL", agent.ProjectId) != nil {
		Raise("project_archived", "Restore the project before sending new work to its Agents")
	}
	if agent.ConversationId != "" && kernelRow(runtime.store.Db, "SELECT 1 FROM conversations WHERE id=? AND archived_at IS NOT NULL", agent.ConversationId) != nil {
		Raise("archived", "The Agent conversation is archived")
	}
}

func agentControlLimit(limit int) int {
	if limit == 0 {
		return 50
	}
	if limit < 1 || limit > 200 {
		Raise("invalid_input", "limit must be an integer from 1 to 200")
	}
	return limit
}

func (runtime *TaskRuntime) listAgentChildren(parent AgentRecord, input AgentControlInput) any {
	limit := agentControlLimit(input.Limit)
	rows := kernelRows(runtime.store.Db, `SELECT a.*,t.paused,COALESCE(k.status,n.status,'idle') AS status
 FROM agents a LEFT JOIN tasks t ON t.id=a.task_id
 LEFT JOIN nodes n ON n.task_id=a.task_id AND n.id=CASE WHEN a.kind='node' THEN a.node_id ELSE 'master' END
 LEFT JOIN kernel_nodes k ON k.task_id=a.task_id AND k.node_id=a.node_id
 WHERE a.parent_id=? AND a.id>? ORDER BY a.id LIMIT ?`, parent.Id, input.AfterId, limit+1)
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	agents := []map[string]any{}
	next := input.AfterId
	for _, row := range rows {
		agent := agentRecordFrom(row)
		agents = append(agents, map[string]any{"id": agent.Id, "parentId": agent.ParentId, "kind": agent.Kind, "name": agent.Name, "taskId": agent.TaskId, "model": agent.Model, "status": row["status"], "paused": kernelInt(row["paused"]) != 0})
		next = agent.Id
	}
	return map[string]any{"agentId": parent.Id, "agents": agents, "hasMore": more, "nextAfterId": next}
}

func (runtime *TaskRuntime) readAgent(agent AgentRecord, input AgentControlInput) any {
	limit := agentControlLimit(input.Limit)
	if input.SinceSeq != nil && *input.SinceSeq < 0 {
		Raise("invalid_input", "sinceSeq must be a nonnegative integer")
	}
	if agent.Kind == "node" {
		query := NodeEntryQuery{}
		size := float64(limit)
		query.Limit = &size
		if input.SinceSeq != nil {
			after := float64(*input.SinceSeq)
			query.After = &after
		}
		page := ListNodeEntries(runtime.store, agent.TaskId, agent.NodeId, query)
		next := int64(0)
		if len(page.Entries) > 0 {
			next = page.Entries[len(page.Entries)-1].Seq
		}
		return map[string]any{"agent": agent, "messages": page.Entries, "nextSeq": next, "hasMore": page.HasNewer, "hasOlder": page.HasOlder}
	}
	query := "SELECT seq,id,role,kind,substr(text,1,4096) AS text,state,operation_id,length(text)>4096 AS truncated FROM messages WHERE conversation_id=?"
	args := []any{agent.ConversationId}
	if input.SinceSeq != nil {
		query += " AND seq>? ORDER BY seq LIMIT ?"
		args = append(args, *input.SinceSeq, limit+1)
	} else {
		query += " ORDER BY seq DESC LIMIT ?"
		args = append(args, limit+1)
	}
	rows := kernelRows(runtime.store.Db, query, args...)
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	if input.SinceSeq == nil {
		rows = conversationReverseRows(rows)
	}
	messages := []map[string]any{}
	next := int64(0)
	if input.SinceSeq != nil {
		next = int64(*input.SinceSeq)
	}
	for _, row := range rows {
		next = kernelInt(row["seq"])
		messages = append(messages, map[string]any{"id": row["id"], "seq": row["seq"], "role": row["role"], "kind": row["kind"], "text": row["text"], "state": row["state"], "operationId": row["operation_id"], "contentTruncated": kernelInt(row["truncated"]) != 0})
	}
	return map[string]any{"agent": agent, "messages": messages, "nextSeq": next, "hasMore": more && input.SinceSeq != nil, "hasOlder": more && input.SinceSeq == nil, "paused": runtime.store.Task(agent.TaskId).Paused != 0}
}
