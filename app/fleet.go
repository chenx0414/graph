package main

import (
	"encoding/json"
	"net/url"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
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
	agentFilter    string
	category       string
	generation     int
	toggled        map[string]bool
	windows        map[string]int
	rects          map[string]ui.Rect
	accents        map[string]ui.Color
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
	state := &s.fleet
	if state.loading {
		return
	}
	scope := s.activeID
	if state.data != nil && state.conversationID == scope {
		return
	}
	path := "/api/fleet"
	if scope != "" {
		path += "?conversationId=" + url.QueryEscape(scope)
	}
	state.loading = true
	state.failed = ""
	state.conversationID = scope
	state.data = nil
	state.generation++
	generation := state.generation
	go func() {
		payload, err := s.api.get(path)
		if state.generation != generation {
			return
		}
		if err != nil {
			state.failed = "读不到编队数据：" + err.Error()
			state.loading = false
			s.frame()
			return
		}
		data, err := parseFleet(payload)
		if err != nil {
			state.failed = "编队数据格式不对"
			state.loading = false
			s.frame()
			return
		}
		state.data = data
		state.loading = false
		s.frame()
	}()
}

func (s *shellState) refreshFleet() {
	s.fleet.data = nil
	s.fleet.conversationID = ""
	s.fleet.loading = false
	s.fleet.generation++
	s.ensureFleet()
}

func (s *shellState) fleetData(ctx *ui.Context) *fleetSnapshot {
	t := gwtheme.Of(ctx)
	if data := s.fleet.data; data != nil {
		return data
	}
	text := "正在读取编队…"
	if s.fleet.failed != "" {
		text = s.fleet.failed
	}
	kit.Text(ctx, text, t.Text.Sm).TextColor(t.Muted)
	if !s.fleet.loading && s.fleet.failed == "" {
		s.ensureFleet()
	}
	return nil
}

func (s *shellState) toggleFleetGroup(key string, open bool) {
	if s.fleet.toggled == nil {
		s.fleet.toggled = map[string]bool{}
	}
	s.fleet.toggled[key] = open
	s.frame()
}

func (s *shellState) pageFleetGroup(key string) {
	if s.fleet.windows == nil {
		s.fleet.windows = map[string]int{}
	}
	limit := fleetWindowStep
	if current, ok := s.fleet.windows[key]; ok && current > limit {
		limit = current
	}
	s.fleet.windows[key] = limit + fleetWindowStep
	s.frame()
}

func (s *shellState) ensureGlobalFleet() {
	state := &s.fleet
	if state.globalLoading || state.global != nil {
		return
	}
	state.globalLoading = true
	state.globalFailed = ""
	go func() {
		payload, err := s.api.get("/api/fleet")
		if err != nil {
			state.globalFailed = "读不到全局编队：" + err.Error()
			state.globalLoading = false
			s.frame()
			return
		}
		data, err := parseFleet(payload)
		if err != nil {
			state.globalFailed = "全局编队数据格式不对"
			state.globalLoading = false
			s.frame()
			return
		}
		state.global = data
		state.globalLoading = false
		s.frame()
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
