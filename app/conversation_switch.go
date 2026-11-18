package main

import "strings"

// chatCacheLimit bounds how many conversations keep their transcript on hand, so
// coming back to one paints at once without asking the console first.
const chatCacheLimit = 12

// beginConversationSwitch puts the conversation on screen straight away. A
// conversation the user already visited brings its transcript with it, so the
// switch paints content instead of a skeleton; the newest replies land after it,
// in selectConversation's background read.
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
	if cached := s.cachedChatLocked(id); cached != nil {
		cached.window = s.window
		cached.providerOn = s.providersEnabled
		cached.loading = false
		cached.status = ""
		s.chat = cached
		s.chatMu.Unlock()
		s.resetConversationBoardData()
		s.frame()
		return cached
	}
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

// cachedChatLocked returns the conversation's chat when it still has content to
// show. The caller holds chatMu.
func (s *shellState) cachedChatLocked(id string) *chatState {
	state := s.chats[id]
	if state == nil || len(state.messages) == 0 {
		return nil
	}
	return state
}

// hasCachedChat reports whether the conversation can paint without a read.
func (s *shellState) hasCachedChat(id string) bool {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	return s.cachedChatLocked(id) != nil
}

// rememberChat keeps a conversation's chat for the next visit. Only conversation
// chats are kept: a node chat belongs to its task and is read again anyway.
func (s *shellState) rememberChat(state *chatState) {
	if state == nil || state.active == "" {
		return
	}
	if _, ok := state.source.(*conversationChatSource); !ok {
		return
	}
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	if s.chats == nil {
		s.chats = map[string]*chatState{}
	}
	if _, kept := s.chats[state.active]; !kept {
		s.chatOrder = append(s.chatOrder, state.active)
	}
	s.chats[state.active] = state
	for len(s.chatOrder) > chatCacheLimit {
		oldest := s.chatOrder[0]
		s.chatOrder = s.chatOrder[1:]
		if oldest != s.activeID {
			delete(s.chats, oldest)
		}
	}
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
