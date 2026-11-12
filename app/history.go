package main

import (
	"sort"
	"strconv"
)

const historyPageSize = 200

func oldestSeqOf(messages []transcriptMessage) int64 {
	oldest := int64(0)
	for _, message := range messages {
		if message.Seq <= 0 {
			continue
		}
		if oldest == 0 || message.Seq < oldest {
			oldest = message.Seq
		}
	}
	return oldest
}

func mergeMessages(older, newer []transcriptMessage) []transcriptMessage {
	merged := make([]transcriptMessage, 0, len(older)+len(newer))
	seen := map[string]bool{}
	for _, list := range [][]transcriptMessage{newer, older} {
		for _, message := range list {
			key := message.ID
			if key == "" {
				key = strconv.FormatInt(message.Seq, 10) + "|" + message.Role + "|" + message.Text
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, message)
		}
	}
	sort.SliceStable(merged, func(i, j int) bool { return merged[i].Seq < merged[j].Seq })
	return merged
}

func (c *chatState) ensureHistory() {
	if c.historyLoading || c.noMoreHistory || c.oldestSeq <= 0 || c.active == "" {
		return
	}
	c.historyLoading = true
	id, before := c.active, c.oldestSeq
	go func() {
		payload, err := c.api.get("/api/conversations/" + id + "/history?before=" + strconv.FormatInt(before, 10) + "&limit=" + strconv.Itoa(historyPageSize))
		if err != nil {
			c.status = "读不到更早的对话：" + err.Error()
			c.historyLoading = false
			c.frame()
			return
		}
		raw, err := parseConversationRaw(payload)
		if err != nil {
			c.status = "更早的对话不是预期的 JSON：" + err.Error()
			c.historyLoading = false
			c.frame()
			return
		}
		raw = olderBefore(raw, before)
		kept, err := parseConversationMessages(payload)
		if err != nil {
			c.status = "更早的对话不是预期的 JSON：" + err.Error()
			c.historyLoading = false
			c.frame()
			return
		}
		kept = olderBefore(kept, before)
		if len(raw) == 0 {
			c.noMoreHistory = true
		} else {
			if len(kept) > 0 {
				c.messages = mergeMessages(kept, c.messages)
				c.pagedHistory = true
				c.runBoundaries[kept[0].ID] = true
			}
			c.oldestSeq = oldestSeqOf(raw)
			if len(raw) < historyPageSize {
				c.noMoreHistory = true
			}
		}
		c.historyLoading = false
		c.historySettle = 2
		c.frame()
	}()
}

func olderBefore(messages []transcriptMessage, before int64) []transcriptMessage {
	filtered := make([]transcriptMessage, 0, len(messages))
	for _, message := range messages {
		if message.Seq <= 0 || message.Seq >= before {
			continue
		}
		filtered = append(filtered, message)
	}
	return filtered
}

