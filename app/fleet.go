package main

import (
	"encoding/json"
	"net/url"

	"github.com/egoist/mygo/ui"
)

const (
	fleetPageID        = "fleet"
	fleetPageTitle     = "编队"
	fleetWindowStep    = 24
	fleetAutoExpand    = 40
	fleetEventLimit    = 20
	fleetTaskLimit     = 12
	fleetTimeline      = 12
	fleetArtifactLimit = 12
)

type fleetStats struct {
	Agents   int     `json:"agents"`
	Running  int     `json:"running"`
	Tasks    int     `json:"tasks"`
	Messages int     `json:"messages"`
	Tokens   int64   `json:"tokens"`
	Cost     float64 `json:"cost"`
}

type fleetAgent struct {
	ID                 string  `json:"id"`
	ParentID           string  `json:"parentId"`
	Kind               string  `json:"kind"`
	Role               string  `json:"role"`
	Name               string  `json:"name"`
	Model              string  `json:"model"`
	ProjectID          string  `json:"projectId"`
	ConversationID     string  `json:"conversationId"`
	TaskID             string  `json:"taskId"`
	NodeID             string  `json:"nodeId"`
	Status             string  `json:"status"`
	Activity           string  `json:"activity"`
	Tokens             int64   `json:"tokens"`
	Cost               float64 `json:"cost"`
	Requests           int     `json:"requests"`
	Messages           int     `json:"messages"`
	CreatedAt          int64   `json:"createdAt"`
	UpdatedAt          int64   `json:"updatedAt"`
	CurrentOperationID string  `json:"currentOperationId"`
}

type fleetLink struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

type fleetTask struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	Phase        string `json:"phase"`
	OwnerAgentID string `json:"ownerAgentId"`
	ProjectID    string `json:"projectId"`
	TaskID       string `json:"taskId"`
	NodeID       string `json:"nodeId"`
	StartedAt    int64  `json:"startedAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

type fleetEvent struct {
	ID            string `json:"id"`
	At            int64  `json:"at"`
	Type          string `json:"type"`
	AgentID       string `json:"agentId"`
	TargetAgentID string `json:"targetAgentId"`
	TaskID        string `json:"taskId"`
	Text          string `json:"text"`
}

type fleetArtifact struct {
	ArtifactID      string `json:"artifactId"`
	TaskID          string `json:"taskId"`
	Namespace       string `json:"namespace"`
	Name            string `json:"name"`
	Title           string `json:"title"`
	MediaType       string `json:"mediaType"`
	Version         int    `json:"version"`
	Size            int64  `json:"size"`
	ProducerAgentID string `json:"producerAgentId"`
	ProducerTaskID  string `json:"producerTaskId"`
	CreatedAt       int64  `json:"createdAt"`
}

type fleetSnapshot struct {
	RootID    string          `json:"rootId"`
	Truncated bool            `json:"truncated"`
	Stats     fleetStats      `json:"stats"`
	Agents    []fleetAgent    `json:"agents"`
	Links     []fleetLink     `json:"links"`
	Tasks     []fleetTask     `json:"tasks"`
	Events    []fleetEvent    `json:"events"`
	Artifacts []fleetArtifact `json:"artifacts"`
}

type fleetActivity struct {
	ID    string
	At    int64
	Role  string
	Kind  string
	Text  string
	State string
}

type fleetDetailEntry struct {
	agentID string
	loading bool
	failed  string
	entries []fleetActivity
}

type fleetState struct {
	conversationID string
	loading        bool
	failed         string
	data           *fleetSnapshot
	global         *fleetSnapshot
	globalLoading  bool
	globalFailed   string
	detail         fleetDetailEntry
	hoverID        string
	hoverScope     string
	agentFilter    string
	category       string
	generation     int
	netScroll      ui.ScrollState
	netKey         string
	accents        map[string]ui.Color
	swimQuery      string
	swimOldest     bool
	swimPick       string
	shares         map[string]float64
}

func parseFleet(payload []byte) (*fleetSnapshot, error) {
	var data fleetSnapshot
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, err
	}
	if data.Agents == nil {
		data.Agents = []fleetAgent{}
	}
	if data.Links == nil {
		data.Links = []fleetLink{}
	}
	if data.Tasks == nil {
		data.Tasks = []fleetTask{}
	}
	if data.Events == nil {
		data.Events = []fleetEvent{}
	}
	if data.Artifacts == nil {
		data.Artifacts = []fleetArtifact{}
	}
	return &data, nil
}

func (s *shellState) ensureFleet() {
	if s.conversationDataBlocked() {
		return
	}
	state := &s.fleet
	if state.conversationID == s.fleetScope() && (state.data != nil || state.loading) {
		return
	}
	s.loadFleet()
}

func (s *shellState) fleetScope() string {
	if active := s.active(); active != nil {
		if _, node := active.source.(*nodeChatSource); node {
			return s.supervisorID
		}
	}
	return s.activeID
}

func (s *shellState) loadFleet() {
	state := &s.fleet
	scope := s.fleetScope()
	path := "/api/fleet"
	if scope != "" {
		path += "?conversationId=" + url.QueryEscape(scope)
	}
	state.loading = true
	state.failed = ""
	if state.conversationID != scope {
		state.data = nil
	}
	state.conversationID = scope
	state.generation++
	generation := state.generation
	api := s.api
	go func() {
		payload, err := api.get(path)
		var data *fleetSnapshot
		if err == nil {
			data, err = parseFleet(payload)
		}
		s.updates.post(s.window, func() {
			if s.fleet.generation != generation || s.fleetScope() != scope || s.api != api {
				return
			}
			s.fleet.loading = false
			if err != nil {
				s.fleet.failed = "读不到编队数据：" + err.Error()
				return
			}
			s.fleet.data = data
		})
	}()
}

func (s *shellState) refreshFleet() {
	if s.fleet.loading && s.fleet.conversationID == s.fleetScope() {
		return
	}
	s.loadFleet()
}

func (s *shellState) fleetData(ctx *ui.Context) *fleetSnapshot {
	if data := s.fleet.data; data != nil {
		return data
	}
	if s.fleetUnavailable(ctx) {
		return nil
	}
	skeletonFleetRows(ctx, 4)
	return nil
}

func (s *shellState) ensureGlobalFleet() {
	if s.conversationDataBlocked() {
		return
	}
	state := &s.fleet
	if state.globalLoading || state.global != nil {
		return
	}
	state.globalLoading = true
	state.globalFailed = ""
	api := s.api
	go func() {
		payload, err := api.get("/api/fleet")
		var data *fleetSnapshot
		if err == nil {
			data, err = parseFleet(payload)
		}
		s.updates.post(s.window, func() {
			s.fleet.globalLoading = false
			if s.api != api {
				return
			}
			if err != nil {
				s.fleet.globalFailed = "读不到全局编队：" + err.Error()
				return
			}
			s.fleet.global = data
		})
	}()
}

func (s *shellState) selectFleetAgentFilter(id string) {
	if s.fleet.agentFilter == id {
		s.fleet.agentFilter = ""
	} else {
		s.fleet.agentFilter = id
	}
	s.frame()
}

func (s *shellState) selectFleetCategory(category string) {
	s.fleet.category = category
	s.frame()
}

func (s *shellState) openFleetArtifact(artifact fleetArtifact) {
	s.openModule("artifacts")
	active := s.active()
	if active == nil {
		return
	}
	row := artifactRow{
		artifactID: artifact.ArtifactID, taskID: artifact.TaskID,
		namespace: artifact.Namespace, name: artifact.Name, title: artifact.Title,
		mediaType: artifact.MediaType, version: artifact.Version, size: artifact.Size,
	}
	active.previewRow = row
	active.previewTitle = artifactLabel(row)
	active.preview = "正在读取产物…"
	go func() {
		payload, err := active.artifactContent(row)
		s.updates.post(s.window, func() {
			if s.active() != active || active.previewRow != row {
				return
			}
			if err != nil {
				active.preview = "读不到产物：" + err.Error()
				return
			}
			active.setArtifactPreview(row, payload)
		})
	}()
}

func fleetArtifactGroups(data *fleetSnapshot) []fleetArtifactGroup {
	index := fleetIndex(data)
	groups := []fleetArtifactGroup{}
	at := map[string]int{}
	for _, artifact := range data.Artifacts {
		producer := artifact.ProducerAgentID
		name := fleetAgentName(index, producer)
		if producer == "" {
			name = "未归属"
		}
		if group, ok := at[producer]; ok {
			groups[group].Artifacts = append(groups[group].Artifacts, artifact)
			continue
		}
		at[producer] = len(groups)
		groups = append(groups, fleetArtifactGroup{ProducerID: producer, Producer: name, Artifacts: []fleetArtifact{artifact}})
	}
	return groups
}

type fleetArtifactGroup struct {
	ProducerID string
	Producer   string
	Artifacts  []fleetArtifact
}
