package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
)

// collabMessage reports whether the message comes from another agent (a project
// supervisor, a peer or a sub-agent) rather than from the user. Those messages
// travel through the same conversation so the master agent can answer them, but
// they are internal cooperation, not something the user said.
func collabMessage(message transcriptMessage) bool {
	switch message.Data.Source.Kind {
	case "agent", "supervisor", "peer":
		return true
	}
	return false
}

// splitCollabMessages splits the transcript into what the user said (and the
// assistant answered) and the agent to agent messages the collaboration card
// owns.
func splitCollabMessages(messages []transcriptMessage) (spoken, collab []transcriptMessage) {
	for _, message := range messages {
		if collabMessage(message) {
			collab = append(collab, message)
			continue
		}
		spoken = append(spoken, message)
	}
	return spoken, collab
}

// collabMessageText returns the sender label and the readable body of an agent
// message. The envelope (the "[来自项目主管的通知]" tag and the bookkeeping
// lines under it) stays out of sight: the card shows what was said.
func collabMessageText(message transcriptMessage) (label, detail string) {
	text := strings.TrimSpace(message.Text)
	tagged := false
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "[来自项目主管的通知]") {
			tagged = true
			continue
		}
		if tagged {
			if content, ok := trimmedContentLine(trimmed); ok {
				return "项目主管通知", content
			}
			continue
		}
		return "Agent 消息", trimmed
	}
	if tagged {
		return "项目主管通知", ""
	}
	return "Agent 消息", ""
}

func trimmedContentLine(line string) (string, bool) {
	for _, prefix := range []string{"内容:", "内容：", "内容 :"} {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix)), true
		}
	}
	return "", false
}

// collabMessageMeta names who sent the message to which conversation, so the
// card reads like a cross agent timeline instead of a chat bubble.
func collabMessageMeta(message transcriptMessage, label string) string {
	meta := []string{label}
	if summary := strings.TrimSpace(message.Data.Source.Summary); summary != "" && summary != "update" {
		meta = append(meta, summary)
	}
	if from := strings.TrimSpace(message.Data.Source.ConversationID); from != "" {
		meta = append(meta, from)
	}
	return strings.Join(meta, " · ")
}

// collabCard draws the cross-agents conversation as the DSH-style swimlane
// card (see chat_collab_swimlane.go): one lane per agent, time-ordered events,
// sender -> receiver links and the header stats. It keeps the "跨 Agent 协作"
// label and the expanded["collab"] toggle the chat already used.
func (c *chatState) collabCard(ctx *ui.Context, messages []transcriptMessage) {
	c.renderCollabSwimlane(ctx, messages)
}
