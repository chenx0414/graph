package main

import (
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

type transcriptMessage struct {
	ID    string `json:"id"`
	Role  string `json:"role"`
	Kind  string `json:"kind"`
	Text  string `json:"text"`
	State string `json:"state"`
	Data  struct {
		Tool       string `json:"tool"`
		ToolCallID string `json:"toolCallId"`
		Ordinal    int    `json:"ordinal"`
	} `json:"data"`
}

type transcriptRun struct {
	tools    bool
	messages []transcriptMessage
}

func groupRuns(messages []transcriptMessage) []transcriptRun {
	runs := []transcriptRun{}
	for _, message := range messages {
		isTool := message.Role == "tool"
		if isTool && len(runs) > 0 && runs[len(runs)-1].tools {
			runs[len(runs)-1].messages = append(runs[len(runs)-1].messages, message)
			continue
		}
		runs = append(runs, transcriptRun{tools: isTool, messages: []transcriptMessage{message}})
	}
	return runs
}

func runSummary(run transcriptRun) string {
	names := []string{}
	seen := map[string]bool{}
	running := false
	for _, message := range run.messages {
		name := message.Data.Tool
		if name == "" {
			name = "tool"
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
		if message.State != "done" {
			running = true
		}
	}
	head := strings.Join(names, ", ")
	if running {
		return head + " · 进行中"
	}
	return head
}

func messageStreaming(message transcriptMessage) bool {
	return message.Role == "assistant" && message.State == "streaming"
}

func runKey(run transcriptRun) string {
	if len(run.messages) == 0 {
		return ""
	}
	return run.messages[0].Data.ToolCallID
}

func toolLine(message transcriptMessage) string {
	name := message.Data.Tool
	if name == "" {
		name = "tool"
	}
	state := "完成"
	if message.State != "done" {
		state = "进行中"
	}
	text := strings.TrimSpace(message.Text)
	if index := strings.Index(text, ": "); index >= 0 && index < 40 {
		text = text[index+2:]
	}
	if newline := strings.Index(text, "\n"); newline >= 0 {
		text = text[:newline]
	}
	runes := []rune(text)
	if len(runes) > 80 {
		text = string(runes[:80]) + "…"
	}
	if text == "" {
		return name + " · " + state
	}
	return name + " · " + state + " · " + text
}

func messageQueued(message transcriptMessage) bool {
	return message.State == "queued"
}

type chatState struct {
	nodeTitle      string
	nodeTaskID     string
	nodeID         string
	nodeRole       string
	nodeDraft      string
	nodeLines      []string
	tasks          []taskRow
	artifacts      []artifactRow
	previewTitle   string
	previewRow     artifactRow
	preview        string
	questions      []openQuestion
	artifactsOpen  bool
	graphOpen      bool
	visible        int
	loadedOlderFor int
	expanded       map[string]bool
	window         *mygo.Window
	address        string
	token          string
	draft          string
	active         string
	status         string
	messages       []transcriptMessage
	list           ui.ListState
	md             markdown.Options
}

func newChatState(address, token string) *chatState {
	state := &chatState{address: address, token: token, status: "正在读取会话…", expanded: map[string]bool{}, visible: transcriptWindow}
	state.list.FollowEnd = true
	state.list.FollowAnimation = &ui.Smooth
	return state
}

func (c *chatState) loadOlderAtTop() bool {
	first, last := c.list.Visible()
	if last < 0 || first > 0 {
		return false
	}
	if c.loadedOlderFor == c.visible {
		return false
	}
	c.loadedOlderFor = c.visible
	c.visible += transcriptWindow
	return true
}

func windowStart(total, visible int) int {
	if visible <= 0 {
		visible = transcriptWindow
	}
	if total <= visible {
		return 0
	}
	return total - visible
}
