package main

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

type transcriptMessageSource struct {
	Kind           string `json:"kind"`
	Form           string `json:"form"`
	Summary        string `json:"summary"`
	Tool           string `json:"toolName"`
	ToolCall       string `json:"toolCallId"`
	State          string `json:"state"`
	ConversationID string `json:"conversationId"`
	TaskID         string `json:"taskId"`
}

type transcriptMessageData struct {
	VerificationDraft *chatVerificationDraft  `json:"verificationDraft"`
	Tool              string                  `json:"tool"`
	Source            transcriptMessageSource `json:"source"`
	ToolCallID        string                  `json:"toolCallId"`
	Ordinal           int                     `json:"ordinal"`
	Output            string                  `json:"output"`
	Message           string                  `json:"message"`
	Command           string                  `json:"command"`
	Args              string                  `json:"args"`
	Error             bool                    `json:"error"`
	ErrorText         string                  `json:"-"`
}

func (data *transcriptMessageData) UnmarshalJSON(payload []byte) error {
	var body struct {
		VerificationDraft *chatVerificationDraft  `json:"verificationDraft"`
		Tool              string                  `json:"tool"`
		Source            transcriptMessageSource `json:"source"`
		ToolCallID        string                  `json:"toolCallId"`
		Ordinal           int                     `json:"ordinal"`
		Output            string                  `json:"output"`
		Message           string                  `json:"message"`
		Command           string                  `json:"command"`
		Args              string                  `json:"args"`
		Error             json.RawMessage         `json:"error"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return err
	}
	failed, text := parseTranscriptError(body.Error)
	*data = transcriptMessageData{
		VerificationDraft: body.VerificationDraft,
		Tool:              body.Tool, Source: body.Source, ToolCallID: body.ToolCallID, Ordinal: body.Ordinal,
		Output: body.Output, Message: body.Message, Command: body.Command, Args: body.Args,
		Error: failed, ErrorText: text,
	}
	return nil
}

func parseTranscriptError(raw json.RawMessage) (bool, string) {
	if len(raw) == 0 {
		return false, ""
	}
	var failed bool
	if json.Unmarshal(raw, &failed) == nil {
		return failed, ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text) != "", text
	}
	return false, ""
}

type transcriptMessage struct {
	ID          string                `json:"id"`
	Seq         int64                 `json:"seq"`
	Role        string                `json:"role"`
	Kind        string                `json:"kind"`
	Text        string                `json:"text"`
	State       string                `json:"state"`
	OperationID string                `json:"operationId"`
	CreatedAt   int64                 `json:"createdAt"`
	Data        transcriptMessageData `json:"data"`
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
	spoken, _ := splitCollabMessages(c.messages)
	return groupRunsAt(spoken, c.runBoundarySnapshot())
}

func (c *chatState) markRunBoundary(id string) {
	if id == "" {
		return
	}
	c.boundaryMu.Lock()
	if c.runBoundaries == nil {
		c.runBoundaries = map[string]bool{}
	}
	c.runBoundaries[id] = true
	c.boundaryMu.Unlock()
}

func (c *chatState) runBoundarySnapshot() map[string]bool {
	c.boundaryMu.RLock()
	defer c.boundaryMu.RUnlock()
	if len(c.runBoundaries) == 0 {
		return nil
	}
	copied := make(map[string]bool, len(c.runBoundaries))
	for id := range c.runBoundaries {
		copied[id] = true
	}
	return copied
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

type chatState struct {
	refreshMu          sync.Mutex
	tasks              []taskRow
	artifacts          []artifactRow
	previewTitle       string
	previewRow         artifactRow
	preview            string
	questions          []openQuestion
	paused             bool
	roundMaster        string
	models             []modelChoice
	modelsLoading      bool
	currentModel       string
	currentThinking    string
	modelTelemetryHold int
	openProviders      func()
	oldestSeq          int64
	listFirst          int
	listLast           int
	track              edgeScroll
	boundaryMu         sync.RWMutex
	runBoundaries      map[string]bool
	jumpMessageID      string
	historySettle      int
	historyLoading     bool
	noMoreHistory      bool
	pagedHistory       bool
	fingerprint        string
	expanded           map[string]bool
	window             *mygo.Window
	api                apiClient
	draft              string
	caret              int
	pendingCaret       int
	menuTrigger        *composerTrigger
	menuActive         int
	menuDismissed      string
	pathQuery          string
	pathItems          []composerPathEntry
	pathLoading        bool
	skillItems         []composerSkillEntry
	skillsLoading      bool
	modelPicker        modelPickerState
	providerOn         func(string) bool
	projectID          string
	projectRoot        string
	attachments        []composerAttachment
	focusComposer      bool
	active             string
	source             agentChatSource
	agentTitle         string
	agentStatus        string
	status             string
	problem            string
	loading            bool
	pollAt             time.Time
	polling            bool
	// answerClocks keeps the last stopwatch reading of an answer the window saw
	// streaming, keyed by message ID, so a settled answer freezes instead of
	// resetting.
	answerClocks map[string]int64
	messages     []transcriptMessage
	list         ui.ListState
	md           markdown.Options
}

func newChatState(address, token string) *chatState {
	state := &chatState{api: newAPIClient(address, token), status: "正在读取会话…", expanded: map[string]bool{}, runBoundaries: map[string]bool{}, listFirst: -1, listLast: -1, pendingCaret: -1}
	state.list.FollowEnd = true
	state.list.FollowAnimation = &ui.Smooth
	state.md.CodeBlock = func(ctx *ui.Context, block *markdown.CodeBlockView) {
		fade := ui.Box(ctx).FillWidth().MaskLinearGradient(chatRightFade())
		fade.Children(func() { markdown.DefaultCodeBlock(ctx, block) })
	}
	return state
}

func newestMessageSeq(messages []transcriptMessage) int64 {
	newest := int64(0)
	for _, message := range messages {
		if message.Seq > newest {
			newest = message.Seq
		}
	}
	return newest
}
