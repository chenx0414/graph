package main

import (
	"encoding/json"
	"strings"
)

func parseNodeRunEntries(payload []byte) ([]transcriptMessage, bool, error) {
	var raw struct {
		HasOlder bool `json:"hasOlder"`
		Entries  []struct {
			Seq       int64  `json:"seq"`
			ID        string `json:"id"`
			Role      string `json:"role"`
			Kind      string `json:"kind"`
			Text      string `json:"text"`
			State     string `json:"state"`
			CreatedAt int64  `json:"createdAt"`
			Data      struct {
				ToolCallID string `json:"toolCallId"`
				ToolName   string `json:"toolName"`
				IsError    *bool  `json:"isError"`
			} `json:"data"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, false, err
	}
	outputs := map[string]string{}
	failed := map[string]bool{}
	for _, entry := range raw.Entries {
		if entry.Kind == "result" && entry.Data.ToolCallID != "" {
			outputs[entry.Data.ToolCallID] = nodeToolResultText(entry.Text)
			if entry.Data.IsError != nil && *entry.Data.IsError {
				failed[entry.Data.ToolCallID] = true
			}
		}
	}
	messages := []transcriptMessage{}
	for _, entry := range raw.Entries {
		if entry.Kind == "result" {
			continue
		}
		text := strings.TrimSpace(entry.Text)
		if text == "" {
			continue
		}
		message := transcriptMessage{
			ID: entry.ID, Seq: entry.Seq, Role: entry.Role, Kind: entry.Kind,
			Text: text, State: entry.State, CreatedAt: entry.CreatedAt,
		}
		if message.Role == "tool" {
			name, command, args, ok := nodeToolCallText(text)
			if !ok {
				name = entry.Data.ToolName
				command = text
			}
			if name == "" {
				name = entry.Data.ToolName
			}
			message.Data.Tool = name
			message.Data.ToolCallID = entry.Data.ToolCallID
			message.Data.Command = command
			message.Data.Args = args
			message.Data.Output = outputs[entry.Data.ToolCallID]
			message.Data.Error = failed[entry.Data.ToolCallID]
			message.State = "running"
			if _, ok := outputs[entry.Data.ToolCallID]; ok {
				message.State = "done"
			}
			if command != "" {
				message.Text = name + ": " + command
			}
		}
		if message.ID == "" {
			message.ID = "entry-" + formatSeq(entry.Seq)
		}
		messages = append(messages, message)
	}
	return messages, raw.HasOlder, nil
}

func nodeToolCallText(text string) (name, command, args string, ok bool) {
	var call struct {
		Name string          `json:"name"`
		Args json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal([]byte(text), &call); err != nil || call.Name == "" {
		return "", "", "", false
	}
	args = strings.TrimSpace(string(call.Args))
	var body map[string]any
	if err := json.Unmarshal(call.Args, &body); err == nil {
		for _, key := range []string{"command", "cmd", "path", "query", "url", "pattern"} {
			if value, ok := body[key].(string); ok && value != "" {
				return call.Name, value, args, true
			}
		}
	}
	return call.Name, "", args, true
}

func nodeToolResultText(text string) string {
	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return strings.TrimSpace(text)
	}
	parts := []string{}
	for _, item := range result.Content {
		if item.Type == "text" && strings.TrimSpace(item.Text) != "" {
			parts = append(parts, item.Text)
		}
	}
	return strings.Join(parts, "\n")
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
