package main

import (
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

type transcriptMessage struct {
	ID        string `json:"id"`
	Seq       int64  `json:"seq"`
	Role      string `json:"role"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	State     string `json:"state"`
	CreatedAt int64  `json:"createdAt"`
	Data      struct {
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
	return groupRunsAt(messages, nil)
}

func groupRunsAt(messages []transcriptMessage, boundaries map[string]bool) []transcriptRun {
	runs := []transcriptRun{}
	for _, message := range messages {
		isTool := message.Role == "tool"
		if boundaries[message.ID] {
			runs = append(runs, transcriptRun{tools: isTool, messages: []transcriptMessage{message}})
			continue
		}
		if isTool && len(runs) > 0 && runs[len(runs)-1].tools {
			runs[len(runs)-1].messages = append(runs[len(runs)-1].messages, message)
			continue
		}
		runs = append(runs, transcriptRun{tools: isTool, messages: []transcriptMessage{message}})
	}
	return runs
}

func (c *chatState) runs() []transcriptRun {
	return groupRunsAt(c.messages, c.runBoundaries)
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

func runIdentity(run transcriptRun) any {
	if len(run.messages) == 0 {
		return ""
	}
	if run.messages[0].ID != "" {
		return run.messages[0].ID
	}
	if key := runKey(run); key != "" {
		return key
	}
	return run.messages[0].Text
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
	tasks           []taskRow
	artifacts       []artifactRow
	previewTitle    string
	previewRow      artifactRow
	preview         string
	questions       []openQuestion
	paused          bool
	models          []modelChoice
	modelsLoading   bool
	currentModel    string
	currentThinking string
	oldestSeq       int64
	runBoundaries   map[string]bool
	historySettle   int
	historyLoading  bool
	noMoreHistory   bool
	pagedHistory    bool
	fingerprint     string
	expanded        map[string]bool
	window          *mygo.Window
	api             apiClient
	draft           string
	focusComposer   bool
	active          string
	source          agentChatSource
	agentTitle      string
	agentStatus     string
	agentDetail     func()
	status          string
	messages        []transcriptMessage
	list            ui.ListState
	md              markdown.Options
}

func newChatState(address, token string) *chatState {
	state := &chatState{api: newAPIClient(address, token), status: "正在读取会话…", expanded: map[string]bool{}, runBoundaries: map[string]bool{}}
	state.list.FollowEnd = true
	state.list.FollowAnimation = &ui.Smooth
	state.md.CodeBlock = func(ctx *ui.Context, block *markdown.CodeBlockView) {
		fade := ui.Box(ctx).FillWidth().MaskLinearGradient(chatRightFade())
		fade.Children(func() { markdown.DefaultCodeBlock(ctx, block) })
	}
	return state
}
