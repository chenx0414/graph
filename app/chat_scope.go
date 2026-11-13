package main

import "strings"

type chatScope struct {
	Kind           string
	ConversationID string
	TaskID         string
	NodeID         string
}

func (scope chatScope) key() string {
	switch scope.Kind {
	case "conversation":
		return "conversation:" + scope.ConversationID
	case "node":
		return "node:" + scope.TaskID + "/" + scope.NodeID
	}
	return ""
}

func (scope chatScope) agent() string {
	return strings.TrimSpace(scope.NodeID)
}

func (s *shellState) chatScope() chatScope {
	if chat := s.active(); chat != nil && chat.source != nil {
		return chat.source.Scope()
	}
	return chatScope{}
}
