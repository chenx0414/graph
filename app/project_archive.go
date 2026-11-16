package main

import (
	"net/url"
	"strings"
)

func (s *shellState) archiveProject(projectID string) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return
	}
	go func() {
		body := map[string]any{"requestId": requestID("archive")}
		if _, err := s.api.post("/api/projects/"+url.PathEscape(projectID)+"/archive", body); err != nil {
			onUI(s.window, func() {
				s.status = "归档失败：" + err.Error()
				s.frame()
			})
			return
		}
		onUI(s.window, func() {
			s.dropArchivedProject(projectID)
			s.frame()
		})
	}()
}

func (s *shellState) dropArchivedProject(projectID string) {
	kept := make([]conversationSummary, 0, len(s.conversations))
	for _, conversation := range s.conversations {
		if conversation.ProjectID != projectID {
			kept = append(kept, conversation)
		}
	}
	s.conversations = kept
	if s.activeID != "" && s.activeID == s.supervisorID {
		return
	}
	for _, conversation := range s.conversations {
		if conversation.ID == s.activeID {
			return
		}
	}
	if s.supervisorID != "" {
		s.selectConversation(s.supervisorID)
		return
	}
	if len(s.conversations) > 0 {
		s.selectConversation(s.conversations[0].ID)
		return
	}
	s.chatMu.Lock()
	s.chat = nil
	s.activeID = ""
	s.chatMu.Unlock()
	s.resetConversationBoardData()
}
