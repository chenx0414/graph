package graph

import (
	"encoding/json"
	"net/http"
	"sort"
)

const (
	fleetEventLimit    = 200
	fleetArtifactLimit = 200
	fleetTaskLimit     = 200
	fleetAgentLimit    = 1000
	fleetPayloadLimit  = 2 * 1024 * 1024
)

type FleetAgent struct {
	Id                 string  `json:"id"`
	ParentId           string  `json:"parentId"`
	Kind               string  `json:"kind"`
	Role               string  `json:"role"`
	Name               string  `json:"name"`
	Model              string  `json:"model"`
	ProjectId          string  `json:"projectId"`
	ConversationId     string  `json:"conversationId"`
	TaskId             string  `json:"taskId"`
	NodeId             string  `json:"nodeId"`
	Status             string  `json:"status"`
	Activity           string  `json:"activity"`
	Tokens             int64   `json:"tokens"`
	Cost               float64 `json:"cost"`
	Requests           int64   `json:"requests"`
	Messages           int64   `json:"messages"`
	CreatedAt          int64   `json:"createdAt"`
	UpdatedAt          int64   `json:"updatedAt"`
	CurrentOperationId string  `json:"currentOperationId"`
}

type FleetLink struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

type FleetStats struct {
	Agents   int64   `json:"agents"`
	Running  int64   `json:"running"`
	Tasks    int64   `json:"tasks"`
	Messages int64   `json:"messages"`
	Tokens   int64   `json:"tokens"`
	Cost     float64 `json:"cost"`
}

type FleetTask struct {
	Id           string `json:"id"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	Phase        string `json:"phase"`
	OwnerAgentId string `json:"ownerAgentId"`
	ProjectId    string `json:"projectId"`
	TaskId       string `json:"taskId"`
	NodeId       string `json:"nodeId"`
	StartedAt    int64  `json:"startedAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

type FleetEvent struct {
	Id            string `json:"id"`
	At            int64  `json:"at"`
	Type          string `json:"type"`
	AgentId       string `json:"agentId"`
	TargetAgentId string `json:"targetAgentId"`
	TaskId        string `json:"taskId"`
	Text          string `json:"text"`
}

type FleetArtifact struct {
	ArtifactId      string `json:"artifactId"`
	TaskId          string `json:"taskId"`
	Namespace       string `json:"namespace"`
	Name            string `json:"name"`
	Title           string `json:"title"`
	MediaType       string `json:"mediaType"`
	Version         int64  `json:"version"`
	Size            int64  `json:"size"`
	ProducerAgentId string `json:"producerAgentId"`
	ProducerTaskId  string `json:"producerTaskId"`
	CreatedAt       int64  `json:"createdAt"`
}

type FleetView struct {
	RootId    string          `json:"rootId"`
	Agents    []FleetAgent    `json:"agents"`
	Links     []FleetLink     `json:"links"`
	Stats     FleetStats      `json:"stats"`
	Tasks     []FleetTask     `json:"tasks"`
	Events    []FleetEvent    `json:"events"`
	Artifacts []FleetArtifact `json:"artifacts"`
	Truncated bool            `json:"truncated"`
}

type fleetScope struct {
	rootId         string
	global         bool
	projectId      string
	conversationId string
	anchorTaskId   string
}

func (app *GraphApp) serveFleet(w http.ResponseWriter, r *http.Request) {
	body := fleetPayloadCached(app.runtime.store, r.URL.Query().Get("conversationId"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func fleetPayload(store *TaskStore, conversationId string) []byte {
	return fleetTrim(fleetProjection(store, conversationId))
}

func fleetTrim(view FleetView) []byte {
	body, err := json.Marshal(view)
	if err != nil {
		panic(err)
	}
	for len(body) > fleetPayloadLimit {
		shrunk := false
		switch {
		case len(view.Events) > 0:
			view.Events = view.Events[:len(view.Events)/2]
			shrunk = true
		case len(view.Artifacts) > 0:
			view.Artifacts = view.Artifacts[:len(view.Artifacts)/2]
			shrunk = true
		case len(view.Tasks) > 0:
			view.Tasks = view.Tasks[:len(view.Tasks)/2]
			shrunk = true
		case len(view.Agents) > 1:
			view.Agents = view.Agents[:len(view.Agents)/2]
			view.Links = fleetLinksOf(view.Agents)
			shrunk = true
		}
		if !shrunk {
			return body
		}
		view.Truncated = true
		body, err = json.Marshal(view)
		if err != nil {
			panic(err)
		}
	}
	return body
}

func fleetResolveScope(store *TaskStore, conversationId string) fleetScope {
	if conversationId == "" {
		rootId := agentGlobalId(store)
		return fleetScope{rootId: rootId, global: true}
	}
	row := kernelRow(store.Db, "SELECT id,role,project_id,anchor_task_id FROM conversations WHERE id=?", conversationId)
	if row == nil {
		Raise("not_found", "Conversation not found")
	}
	switch kernelString(row["role"]) {
	case "global":
		return fleetScope{rootId: conversationId, global: true}
	case "project":
		projectId := ""
		if value := conversationNullableString(row["project_id"]); value != nil {
			projectId = *value
		}
		return fleetScope{rootId: conversationId, projectId: projectId, conversationId: conversationId,
			anchorTaskId: kernelString(row["anchor_task_id"])}
	}
	Raise("invalid_input", "Fleet requires a supervisor conversation")
	return fleetScope{}
}

func fleetAgentRank(kind string) int {
	switch kind {
	case "global":
		return 0
	case "project":
		return 1
	case "node":
		return 2
	}
	return 3
}

func fleetProjection(store *TaskStore, conversationId string) FleetView {
	scope := fleetResolveScope(store, conversationId)
	ledger := loadFleetLedger(store)
	archived := archivedProjectSet(store)
	scoped := agentRecords(store)
	if scope.rootId != "" {
		scoped = agentSubtreeOf(scoped, scope.rootId)
	}
	scoped = fleetActiveAgents(scoped, archived)
	sort.SliceStable(scoped, func(left, right int) bool {
		if leftRank, rightRank := fleetAgentRank(scoped[left].Kind), fleetAgentRank(scoped[right].Kind); leftRank != rightRank {
			return leftRank < rightRank
		}
		return scoped[left].Id < scoped[right].Id
	})
	tasks, taskSet := fleetTasks(store, scope, scoped)
	tasks = fleetActiveTasks(tasks, archived)
	stats := FleetStats{Tasks: int64(len(tasks))}
	agents := make([]FleetAgent, 0, len(scoped))
	for _, agent := range scoped {
		view := fleetAgentOf(ledger, agent)
		agents = append(agents, view)
		stats.Agents++
		stats.Messages += view.Messages
		stats.Tokens += view.Tokens
		stats.Cost += view.Cost
		if view.Status == "running" {
			stats.Running++
		}
	}
	truncated := false
	if len(agents) > fleetAgentLimit {
		agents = agents[:fleetAgentLimit]
		truncated = true
	}
	if len(tasks) > fleetTaskLimit {
		tasks = tasks[:fleetTaskLimit]
		truncated = true
	}
	index := fleetIndex(agents, ledger)
	events, eventsTruncated := fleetEvents(store, scope, taskSet, index)
	events = fleetActiveEvents(events, archived, ledger.taskProject)
	if eventsTruncated {
		truncated = true
	}
	artifacts, artifactsTruncated := fleetArtifacts(store, scope, taskSet, index)
	artifacts = fleetActiveArtifacts(artifacts, archived, ledger.taskProject)
	if artifactsTruncated {
		truncated = true
	}
	return FleetView{
		RootId: scope.rootId, Agents: agents, Links: fleetLinksOf(agents), Stats: stats,
		Tasks: tasks, Events: events, Artifacts: artifacts, Truncated: truncated,
	}
}

func fleetLinksOf(agents []FleetAgent) []FleetLink {
	kept := map[string]bool{}
	for _, agent := range agents {
		kept[agent.Id] = true
	}
	links := make([]FleetLink, 0, len(agents))
	for _, agent := range agents {
		if agent.ParentId != "" && kept[agent.ParentId] {
			links = append(links, FleetLink{From: agent.ParentId, To: agent.Id, Kind: "parent"})
		}
	}
	return links
}

type fleetAgentIndex struct {
	byTaskNode       map[string]string
	byConversation   map[string]string
	byTask           map[string]string
	taskConversation map[string]string
	global           string
}

func fleetIndex(agents []FleetAgent, ledger *fleetLedger) fleetAgentIndex {
	index := fleetAgentIndex{
		byTaskNode: map[string]string{}, byConversation: map[string]string{},
		byTask: map[string]string{}, taskConversation: ledger.taskConversation,
	}
	for _, agent := range agents {
		if agent.Kind == "node" {
			index.byTaskNode[fleetKey(agent.TaskId, agent.NodeId)] = agent.Id
		}
		if agent.Kind == "global" && index.global == "" {
			index.global = agent.Id
		}
		if agent.Kind == "global" || agent.Kind == "project" {
			conversationId := agent.ConversationId
			if conversationId == "" {
				conversationId = agent.Id
			}
			index.byConversation[conversationId] = agent.Id
			index.byTask[agent.TaskId] = agent.Id
		}
	}
	return index
}

func (index fleetAgentIndex) agentForEvent(taskId string, data map[string]any) string {
	if nodeId := fleetDataString(data, "nodeId"); nodeId != "" && taskId != "" {
		if agent := index.byTaskNode[fleetKey(taskId, nodeId)]; agent != "" {
			return agent
		}
	}
	if agent := index.byTask[taskId]; agent != "" {
		return agent
	}
	if conversationId := index.taskConversation[taskId]; conversationId != "" {
		if agent := index.byConversation[conversationId]; agent != "" {
			return agent
		}
	}
	return index.global
}

func (index fleetAgentIndex) targetForEvent(taskId string, data map[string]any) string {
	for _, key := range []string{"sourceConversationId", "toConversationId", "targetConversationId"} {
		if value := fleetDataString(data, key); value != "" {
			return index.byConversation[value]
		}
	}
	if nodeId := fleetDataString(data, "toNodeId"); nodeId != "" && taskId != "" {
		return index.byTaskNode[fleetKey(taskId, nodeId)]
	}
	return ""
}

func fleetDataString(data map[string]any, key string) string {
	value, _ := data[key].(string)
	return value
}

func fleetDataRecord(raw string) map[string]any {
	if raw == "" {
		return map[string]any{}
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(raw), &record); err != nil || record == nil {
		return map[string]any{}
	}
	return record
}

func fleetActiveAgents(records []AgentRecord, archived map[string]bool) []AgentRecord {
	active := make([]AgentRecord, 0, len(records))
	for _, record := range records {
		if archived[record.ProjectId] {
			continue
		}
		active = append(active, record)
	}
	return active
}

func fleetActiveTasks(tasks []FleetTask, archived map[string]bool) []FleetTask {
	active := make([]FleetTask, 0, len(tasks))
	for _, task := range tasks {
		if archived[task.ProjectId] {
			continue
		}
		active = append(active, task)
	}
	return active
}

func fleetActiveEvents(events []FleetEvent, archived map[string]bool, taskProjects map[string]string) []FleetEvent {
	active := make([]FleetEvent, 0, len(events))
	for _, event := range events {
		if archived[taskProjects[event.TaskId]] {
			continue
		}
		active = append(active, event)
	}
	return active
}

func fleetActiveArtifacts(artifacts []FleetArtifact, archived map[string]bool, taskProjects map[string]string) []FleetArtifact {
	active := make([]FleetArtifact, 0, len(artifacts))
	for _, artifact := range artifacts {
		if archived[taskProjects[artifact.TaskId]] {
			continue
		}
		active = append(active, artifact)
	}
	return active
}
