package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
)

func (c *chatState) jumpToMessage(at int64, text string) bool {
	index, ok := c.messageIndexForEvent(at, text)
	if !ok {
		return false
	}
	target := c.messages[index]
	for attempt := 0; attempt < 2; attempt++ {
		rows := chatFoldRows(c.runs())
		at, found := jumpRowIndex(rows, target.ID)
		if found {
			c.list.ScrollTo(at, ui.Center)
			c.jumpMessageID = target.ID
			return true
		}
		if !c.expandFoldHolding(rows, target.ID) {
			return false
		}
	}
	return false
}

func jumpRowIndex(rows []chatRow, id string) (int, bool) {
	for at, row := range rows {
		if row.kind == "fold" {
			for _, step := range row.steps {
				for _, message := range step.messages {
					if message.ID == id {
						return at, true
					}
				}
			}
			continue
		}
		for _, message := range row.run.messages {
			if message.ID == id {
				return at, true
			}
		}
	}
	return -1, false
}

func (c *chatState) expandFoldHolding(rows []chatRow, id string) bool {
	for _, row := range rows {
		if row.kind != "fold" {
			continue
		}
		for _, step := range row.steps {
			for _, message := range step.messages {
				if message.ID == id {
					c.expanded[row.foldKey] = true
					return true
				}
			}
		}
	}
	return false
}

func (c *chatState) messageIndexForEvent(at int64, text string) (int, bool) {
	needle := strings.TrimSpace(text)
	if runes := []rune(needle); len(runes) > 30 {
		needle = string(runes[:30])
	}
	best, bestScore := -1, int64(1<<62)
	for index, message := range c.messages {
		score := int64(1 << 61)
		if needle != "" && strings.Contains(message.Text, needle) {
			score = 0
			if message.CreatedAt > 0 && at > 0 {
				diff := message.CreatedAt - at
				if diff < 0 {
					diff = -diff
				}
				score = diff
			}
		} else if at > 0 && message.CreatedAt > 0 {
			diff := message.CreatedAt - at
			if diff < 0 {
				diff = -diff
			}
			if diff <= 5_000 {
				score = diff + 1_000_000
			}
		}
		if score < bestScore {
			best, bestScore = index, score
		}
	}
	if best < 0 || bestScore >= 1<<61 {
		return 0, false
	}
	return best, true
}
