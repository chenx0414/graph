package main

import "strings"

func (s *shellState) beginConversationSwitch(id string) *chatState {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	s.chatMu.Lock()
	if s.activeID == id {
		s.chatMu.Unlock()
		return nil
	}
	s.activeID = id
	state := newChatState(s.api.address, s.api.token)
	state.window = s.window
	state.providerOn = s.providersEnabled
	state.source = newConversationChatSource(s.api, id)
	state.active = id
	state.loading = true
	s.chat = state
	s.chatMu.Unlock()
	s.resetConversationBoardData()
	s.frame()
	return state
}

func (s *shellState) resetConversationBoardData() {
	s.fleet.conversationID = ""
	s.fleet.loading = false
	s.fleet.failed = ""
	s.fleet.data = nil
	s.fleet.detail = fleetDetailEntry{}
	s.fleet.agentFilter = ""
	s.fleet.category = ""
	s.trajectory.reset()
	s.trajectory.scopeKey = ""
	s.trajectory.selected = 0
	s.boardNet = netPanelState{}
}
