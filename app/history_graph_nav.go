package main

import "strings"

// historyGraphSessionTarget classifies where a history graph row leads. A node
// session (task + node) wins over a supervisor conversation, matching the way a
// node card opens elsewhere in the app. Only a real conversation or a complete
// task+node pair counts; a lone task id has no transcript to show.
func historyGraphSessionTarget(conversationID, taskID, nodeID string) string {
	if strings.TrimSpace(taskID) != "" && strings.TrimSpace(nodeID) != "" {
		return "node"
	}
	if strings.TrimSpace(conversationID) != "" {
		return "conversation"
	}
	return ""
}

// openHistoryGraphSession follows a row in the project history browser into the
// conversation or node session that owns it. It returns false when the row has
// no navigable session so the caller can show an empty state instead of
// swapping the reader's current chat.
//
// This is deliberately a thin wrapper over the app's existing chat openers:
// node rows install a node source (which also paints the agent header), and
// conversation rows reuse the cached conversation switch.
func openHistoryGraphSession(s *shellState, conversationID, taskID, nodeID, title string) bool {
	if s == nil {
		return false
	}
	switch historyGraphSessionTarget(conversationID, taskID, nodeID) {
	case "node":
		agent := fleetAgent{
			ID:     "history:" + strings.TrimSpace(taskID) + "/" + strings.TrimSpace(nodeID),
			Kind:   "node",
			Name:   strings.TrimSpace(title),
			TaskID: strings.TrimSpace(taskID),
			NodeID: strings.TrimSpace(nodeID),
		}
		s.openFleetAgentChat(agent)
		return true
	case "conversation":
		s.selectConversation(strings.TrimSpace(conversationID))
		return true
	}
	return false
}
