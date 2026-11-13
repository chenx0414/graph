package main

import (
	"encoding/json"
	"strings"
)

func parseNodeRunEntries(payload []byte) ([]transcriptMessage, error) {
	var raw struct {
		Entries []struct {
			Seq       int64  `json:"seq"`
			ID        string `json:"id"`
			Role      string `json:"role"`
			Kind      string `json:"kind"`
			Text      string `json:"text"`
			State     string `json:"state"`
			CreatedAt int64  `json:"createdAt"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, err
	}
	messages := []transcriptMessage{}
	for _, entry := range raw.Entries {
		text := strings.TrimSpace(entry.Text)
		if text == "" {
			continue
		}
		message := transcriptMessage{
			ID: entry.ID, Seq: entry.Seq, Role: entry.Role, Kind: entry.Kind,
			Text: text, State: entry.State, CreatedAt: entry.CreatedAt,
		}
		if message.ID == "" {
			message.ID = "entry-" + formatSeq(entry.Seq)
		}
		messages = append(messages, message)
	}
	return messages, nil
}

func formatSeq(seq int64) string {
	if seq <= 0 {
		return "0"
	}
	digits := []byte{}
	for seq > 0 {
		digits = append([]byte{byte('0' + seq%10)}, digits...)
		seq /= 10
	}
	return string(digits)
}

func (s *shellState) openFleetAgentChat(agent fleetAgent) {
	if agent.ID == "" {
		return
	}
	if agent.Kind == "node" || (agent.TaskID != "" && agent.NodeID != "") {
		s.installAgentChat(newNodeChatSource(s.api, agent.TaskID, agent.NodeID), agent)
		return
	}
	if agent.ConversationID != "" {
		s.installAgentChat(newConversationChatSource(s.api, agent.ConversationID), agent)
	}
}
