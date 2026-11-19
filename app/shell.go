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
	updates           uiUpdates
	api               apiClient
	status            string
	activeID          string
	chatMu            sync.Mutex
	chat              *chatState
	chats             map[string]*chatState
	chatOrder         []string
	settings          *settingsState
	usage             *usageState
	resources         *resourceState
	assemblies        *assemblyState
	trajectory        trajectoryState
	fleet             fleetState
	fleetHistory      fleetHistoryState
	graph             fleetGraphView
	modelMeta         map[string]modelMeta
	modelMetaResolved map[string]modelMeta
	modelMetaMiss     map[string]bool
	modelMetaLoading  bool
	modelMetaError    string
	providers         providersPageState
	promptScope       string
	promptRecord      *promptRecord
	promptError       string
	promptLoading     bool
	promptFetchedAt   time.Time
	contextTab        int
	boardNet          netPanelState
	conversations     []conversationSummary
	rowsVersion       string
	supervisorID      string
	broken            bool
	board             boardState
	boardScroll       edgeScroll
	viewportScroll    edgeScroll
	listScroll        edgeScroll
	boardScrollTop    bool
	dataReady         atomic.Bool
	dataPending       atomic.Bool
	window            *mygo.Window
	windowFloor       float32
	list              ui.ListState
	stateDir          string
	archiveConfirm    *archiveConfirmState
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

// fetchRows reads the conversation list without touching shell state, so a
// background poll can ask the console and hand the result to the UI thread.
func (s *shellState) fetchRows() (list []conversationSummary, status string, ok bool) {
	payload, err := s.api.get("/api/conversations")
	if err != nil {
		return nil, "读不到会话列表：" + err.Error(), false
	}
	list, err = parseConversations(payload)
	if err != nil {
		return nil, "会话列表不是预期的 JSON：" + err.Error(), false
	}
	return list, "", true
}

// applyRows puts a fetched list on screen. It belongs on the UI thread: a render
// reads s.conversations, so rebuilding it from a poll goroutine would let the
// sidebar see a half rebuilt list (and the list state index past its end).
func (s *shellState) applyRows(list []conversationSummary) bool {
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

func (s *shellState) failRows(status string) bool {
	s.status = status
	s.broken = true
	return false
}

func (s *shellState) loadRows() bool {
	list, status, ok := s.fetchRows()
	if !ok {
		return s.failRows(status)
	}
	return s.applyRows(list)
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

func parseThreadConversationID(payload []byte) string {
	var body struct {
		ConversationID string `json:"conversationId"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return ""
	}
	return strings.TrimSpace(body.ConversationID)
}

func (s *shellState) startMainAgent() {
	if s.supervisorID != "" {
		s.selectConversation(s.supervisorID)
		return
	}
	payload, err := s.api.post("/api/orchestration/global", map[string]string{"requestId": requestID("main-agent")})
	if err != nil {
		s.status = "建不了主会话：" + err.Error()
		s.frame()
		return
	}
	id := parseThreadConversationID(payload)
	if id == "" {
		s.status = "主会话没有返回 id"
		s.frame()
		return
	}
	onUI(s.window, func() {
		s.loadRows()
		if s.supervisorID == "" {
			s.supervisorID = id
		}
		s.selectConversation(id)
	})
}

func (s *shellState) selectConversation(id string) {
	state := s.beginConversationSwitch(id)
	if state == nil {
		return
	}
	if s.window == nil && !s.hasCachedChat(id) {
		state.open(id)
		s.rememberChat(state)
		s.frame()
		return
	}
	s.ensureFleet()
	s.ensureTrajectory()
	s.ensureBoardPageData()
	go s.loadConversationChat(id)
}

// loadConversationChat fills a conversation in after the switch already painted
// it, so the window never waits for the console: a conversation that is on hand
// keeps what it shows and takes the newest replies when they land, and one that
// is not is read into a fresh chat and swapped in once it has content.
func (s *shellState) loadConversationChat(id string) {
	s.chatMu.Lock()
	current := s.chat
	cached := s.cachedChatLocked(id)
	s.chatMu.Unlock()
	if current == nil || current.active != id {
		return
	}
	if cached != nil {
		cached.refresh()
		s.rememberChat(cached)
		s.frame()
		return
	}
	loaded := newChatState(s.api.address, s.api.token)
	loaded.window = s.window
	loaded.providerOn = s.providersEnabled
	loaded.open(id)
	s.chatMu.Lock()
	if s.activeID != id || s.chat != current {
		s.chatMu.Unlock()
		return
	}
	s.chat = loaded
	s.chatMu.Unlock()
	s.rememberChat(loaded)
	s.ensureBoardPageData()
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
	if reload {
		list, status, ok := s.fetchRows()
		if ok {
			s.rowsVersion = version
			onUI(s.window, func() { s.applyRows(list) })
			changed = true
		} else {
			onUI(s.window, func() { s.failRows(status) })
		}
	}
	return changed
}

func (s *shellState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}
