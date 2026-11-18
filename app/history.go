package main

import (
	"sort"
	"strconv"
)

const historyPageSize = 200
const initialMessagePageSize = 60

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
	if c.source == nil || !c.source.Capabilities().History {
		c.noMoreHistory = true
		return
	}
	if c.historyLoading || c.noMoreHistory || c.oldestSeq <= 0 || c.active == "" {
		return
	}
	c.historyLoading = true
	source := c.source
	before := c.oldestSeq
	go func() {
		older, oldest, hasMore, err := source.LoadOlder(c, before)
		if c.source == nil || c.source.Key() != source.Key() {
			return
		}
		if err != nil {
			c.status = "读不到更早的对话：" + err.Error()
			c.historyLoading = false
			c.frame()
			return
		}
		onUI(c.window, func() {
			if len(older) > 0 {
				c.messages = mergeMessages(older, c.messages)
				c.pagedHistory = true
				c.markRunBoundary(older[0].ID)
			}
			if oldest > 0 {
				c.oldestSeq = oldest
			}
			if !hasMore {
				c.noMoreHistory = true
			}
			c.historyLoading = false
			c.historySettle = 2
			c.frame()
		})
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
