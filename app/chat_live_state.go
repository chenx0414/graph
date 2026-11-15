package main

import (
	"encoding/json"
	"sort"
	"strings"
)

func messageActive(message transcriptMessage) bool {
	return message.active()
}

func messageStreaming(message transcriptMessage) bool {
	return message.Role == "assistant" && messagePhaseOf(message) == messagePhaseRunning
}

func messageQueued(message transcriptMessage) bool {
	return message.Role == "user" && messagePhaseOf(message) == messagePhaseQueued
}

type liveStreamPart struct {
	OperationID string `json:"operationId"`
	EntryID     string `json:"entryId"`
	PartID      string `json:"partId"`
	Ordinal     int    `json:"ordinal"`
	Text        string `json:"text"`
	UpdatedAt   int64  `json:"updatedAt"`
}

func parseLiveStreamParts(payload []byte) []liveStreamPart {
	var body struct {
		Streams []liveStreamPart `json:"streams"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return nil
	}
	parts := make([]liveStreamPart, 0, len(body.Streams))
	for _, part := range body.Streams {
		if strings.TrimSpace(part.Text) == "" {
			continue
		}
		parts = append(parts, part)
	}
	return parts
}

func stripLiveMessages(messages []transcriptMessage) []transcriptMessage {
	kept := make([]transcriptMessage, 0, len(messages))
	for _, message := range messages {
		if strings.HasPrefix(message.ID, "live:") {
			continue
		}
		kept = append(kept, message)
	}
	return kept
}

func applyLiveStreams(messages []transcriptMessage, payload []byte) []transcriptMessage {
	messages = stripLiveMessages(messages)
	parts := parseLiveStreamParts(payload)
	if len(parts) == 0 {
		return messages
	}
	settled := map[string]bool{}
	for _, message := range messages {
		if message.Role == "assistant" && message.OperationID != "" {
			settled[message.OperationID] = true
		}
	}
	groups := map[string][]liveStreamPart{}
	order := []string{}
	for _, part := range parts {
		if part.EntryID == "" || settled[part.OperationID] {
			continue
		}
		key := part.OperationID + "/" + part.EntryID
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], part)
	}
	if len(order) == 0 {
		return messages
	}
	seq := int64(0)
	for _, message := range messages {
		if message.Seq > seq {
			seq = message.Seq
		}
	}
	for _, key := range order {
		group := groups[key]
		sort.SliceStable(group, func(i, j int) bool {
			if group[i].Ordinal != group[j].Ordinal {
				return group[i].Ordinal < group[j].Ordinal
			}
			return group[i].PartID < group[j].PartID
		})
		texts := make([]string, 0, len(group))
		startedAt := int64(0)
		for _, part := range group {
			texts = append(texts, part.Text)
			if startedAt == 0 || (part.UpdatedAt > 0 && part.UpdatedAt < startedAt) {
				startedAt = part.UpdatedAt
			}
		}
		text := strings.Join(texts, "")
		if strings.TrimSpace(text) == "" {
			continue
		}
		seq++
		messages = append(messages, transcriptMessage{
			ID:          "live:" + key,
			Seq:         seq,
			Role:        "assistant",
			Kind:        "chat",
			Text:        text,
			State:       "streaming",
			CreatedAt:   startedAt,
			OperationID: group[0].OperationID,
		})
	}
	return messages
}
