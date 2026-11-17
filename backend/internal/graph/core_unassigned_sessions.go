package graph

import "strings"

type ArchiveUnassignedResult struct {
	Archived        int      `json:"archived"`
	ConversationIDs []string `json:"conversationIds"`
}

func (runtime *TaskRuntime) ArchiveUnassignedChildSessions(requestID string) ArchiveUnassignedResult {
	runtime.ensureOpen()
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || len(requestID) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	result := ArchiveUnassignedResult{ConversationIDs: []string{}}
	tasks := []string{}
	for _, agent := range unassignedChildAgents(runtime.store) {
		conversation := ConversationRowOf(runtime.store, agent.ConversationId)
		if conversation.Id == "" {
			continue
		}
		taskID := agent.TaskId
		if taskID == "" {
			taskID = conversation.AnchorTaskId
		}
		if conversation.ArchivedAt == nil {
			runtime.Conversations().Archive(conversation.Id, requestID)
			result.Archived++
			result.ConversationIDs = append(result.ConversationIDs, conversation.Id)
		}
		if taskID != "" {
			runtime.store.SetTaskPaused(taskID, true)
			pauseMasterTurn(runtime, taskID, "archive-unassigned:"+requestID+":"+taskID)
			tasks = append(tasks, taskID)
		}
	}
	if runtime.execution != nil {
		for _, taskID := range tasks {
			runtime.execution.StopActiveMasterTurns(taskID)
		}
	}
	return result
}

func unassignedChildAgents(store *TaskStore) []AgentRecord {
	records := agentRecords(store)
	byID := map[string]AgentRecord{}
	for _, record := range records {
		byID[record.Id] = record
	}
	unassigned := []AgentRecord{}
	for _, record := range records {
		if record.Kind != "child" || record.ConversationId == "" {
			continue
		}
		current := record
		assigned := false
		for current.ParentId != "" {
			parent, ok := byID[current.ParentId]
			if !ok {
				break
			}
			if parent.Kind == "project" {
				assigned = true
				break
			}
			current = parent
		}
		if !assigned {
			unassigned = append(unassigned, record)
		}
	}
	return unassigned
}
