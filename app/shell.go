package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type shellState struct {
	updates          uiUpdates
	api              apiClient
	status           string
	activeID         string
	chatMu           sync.Mutex
	chat             *chatState
	settings         *settingsState
	usage            *usageState
	resources        *resourceState
	assemblies       *assemblyState
	trajectory       trajectoryState
	insights         insightsState
	fleet            fleetState
	graph            fleetGraphView
	modelMeta        map[string]modelMeta
	modelMetaLoading bool
	modelMetaError   string
	providers        providersPageState
	promptScope      string
	promptRecord     *promptRecord
	promptError      string
	promptLoading    bool
	promptFetchedAt  time.Time
	contextTab       int
	boardNet         netPanelState
	conversations    []conversationSummary
	rowsVersion      string
	supervisorID     string
	broken           bool
	board            boardState
	boardScroll      ui.ScrollState
	boardScrollTop   bool
	dataReady        atomic.Bool
	dataPending      atomic.Bool
	window           *mygo.Window
	list             ui.ListState
	stateDir         string
	archiveConfirm   *archiveConfirmState
}

func newShellState(address, token string) *shellState {
	state := &shellState{
		api:    newAPIClient(address, token),
		status: "正在读取会话…",
		board:  boardState{pages: defaultBoardPages()},
	}
	state.dataReady.Store(true)
	return state
}

func (s *shellState) blockBoardDataUntilConversation() {
	s.dataReady.Store(false)
}

func (s *shellState) conversationDataBlocked() bool {
	if s.dataReady.Load() {
		return false
	}
	s.dataPending.Store(true)
	return true
}

func (s *shellState) markConversationReady() {
	s.dataReady.Store(true)
	if s.dataPending.Swap(false) {
		onUI(s.window, func() { s.ensureBoardPageData() })
	}
	s.frame()
}

func (s *shellState) active() *chatState {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	return s.chat
}

func requestID(prefix string) string {
	return prefix + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func (s *shellState) adoptConsole(paths Paths) bool {
	info, ok := paths.ReadConsole()
	if !ok || info.URL == "" || info.URL == s.api.address {
		return false
	}
	s.api = newAPIClient(info.URL, paths.SessionToken())
	s.broken = true
	return true
}

func (s *shellState) probeRowsVersion() string {
	payload, err := s.api.get("/api/conversations/version")
	if err != nil {
		return ""
	}
	parsed := struct {
		Version string `json:"version"`
	}{}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return ""
	}
	return parsed.Version
}

func (s *shellState) loadRows() bool {
	payload, err := s.api.get("/api/conversations")
	if err != nil {
		s.status = "读不到会话列表：" + err.Error()
		s.broken = true
		return false
	}
	list, err := parseConversations(payload)
	if err != nil {
		s.status = "会话列表不是预期的 JSON：" + err.Error()
		s.broken = true
		return false
	}
	s.supervisorID = ""
	s.conversations = nil
	for _, conversation := range list {
		switch conversation.Role {
		case "global":
			if s.supervisorID == "" {
				s.supervisorID = conversation.ID
			}
		case "project":
			s.conversations = append(s.conversations, conversation)
		}
	}
	s.broken = false
	if len(s.conversations) == 0 {
		s.status = "还没有项目会话。"
		return true
	}
	s.status = ""
	return true
}

func (s *shellState) load() {
	if !s.loadRows() {
		return
	}
	id := s.supervisorID
	if id == "" && len(s.conversations) > 0 {
		id = s.conversations[0].ID
	}
	if id == "" {
		return
	}
	s.selectConversation(id)
	s.chatMu.Lock()
	if s.chat != nil {
		s.chat.focusComposer = true
	}
	s.chatMu.Unlock()
}

func (s *shellState) projectNames() []string {
	names := []string{}
	seen := map[string]bool{}
	for _, conversation := range s.conversations {
		project := strings.TrimSpace(conversation.ProjectID)
		if project == "" {
			project = conversation.Title
		}
		if project == "" || seen[project] {
			continue
		}
		seen[project] = true
		names = append(names, project)
	}
	return names
}

func (s *shellState) ensureSettings() {
	if s.conversationDataBlocked() {
		return
	}
	if s.settings == nil {
		s.settings = newSettingsState(s.api.address, s.api.token)
		s.settings.window = s.window
		s.settings.openProviders = func() { s.openModule("providers") }
		go s.settings.load()
	}
}

func (s *shellState) ensureUsage() {
	if s.conversationDataBlocked() {
		return
	}
	if s.usage == nil {
		s.usage = newUsageState(s.api.address, s.api.token)
		s.usage.window = s.window
		go s.usage.load()
	}
}

func (s *shellState) ensureAssemblies() {
	if s.conversationDataBlocked() {
		return
	}
	if s.assemblies == nil {
		s.assemblies = newAssemblyState(s.api.address, s.api.token)
		s.assemblies.window = s.window
		go s.assemblies.load()
	}
}

func (s *shellState) ensureResources() {
	if s.conversationDataBlocked() {
		return
	}
	if s.resources == nil {
		s.resources = newResourceState(s.api.address, s.api.token)
		s.resources.window = s.window
		s.resources.secretsPath = secretsPath(s.stateDir)
		s.resources.appToken = appToken(s.stateDir)
		go s.resources.load()
	}
}

func (s *shellState) titleOf(id string) string {
	if chat := s.active(); chat != nil && id == s.activeID && chat.agentTitle != "" {
		return chat.agentTitle
	}
	if id != "" && id == s.supervisorID {
		return "Main Agent"
	}
	for _, conversation := range s.conversations {
		if conversation.ID == id {
			if project := strings.TrimSpace(conversation.ProjectID); project != "" {
				return project
			}
			return conversation.Title
		}
	}
	return "（无标题）"
}

func (s *shellState) selectConversation(id string) {
	state := s.beginConversationSwitch(id)
	if state == nil {
		return
	}
	if s.window != nil {
		s.ensureFleet()
		s.ensureTrajectory()
		s.ensureBoardPageData()
		api := s.api
		go func() {
			loaded := newChatState(api.address, api.token)
			loaded.window = s.window
			loaded.providerOn = s.providersEnabled
			loaded.open(id)
			s.chatMu.Lock()
			if s.activeID != id {
				s.chatMu.Unlock()
				return
			}
			s.chat = loaded
			s.chatMu.Unlock()
			s.ensureBoardPageData()
			s.frame()
		}()
		return
	}
	state.open(id)
	s.frame()
}

func (s *shellState) refresh() bool {
	changed := false
	var active *chatState
	reload := false
	onUI(s.window, func() {
		active = s.active()
		reload = s.broken || len(s.conversations) == 0
		s.refreshVisibleWorkspace()
	})
	version := s.probeRowsVersion()
	if version != "" && version != s.rowsVersion {
		reload = true
	}
	if active != nil && !active.loading {
		changed = active.poll()
		if changed || active.artifacts == nil {
			changed = active.refreshArtifacts() || changed
		}
	}
	if changed {
		onUI(s.window, func() { s.refreshTrajectory() })
	}
	if reload && s.loadRows() {
		s.rowsVersion = version
		changed = true
	}
	return changed
}

func (s *shellState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}
