package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

type trajectoryUsage struct {
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	CacheRead     int64 `json:"cacheRead"`
	CacheWrite    int64 `json:"cacheWrite"`
	Total         int64 `json:"total"`
	ContextTokens int64 `json:"contextTokens"`
	FirstTokenMs  int64 `json:"firstTokenMs"`
	DurationMs    int64 `json:"durationMs"`
}

type trajectoryTool struct {
	Name    string `json:"name"`
	Ms      int64  `json:"ms"`
	IsError bool   `json:"isError"`
	At      int64  `json:"at"`
}

type trajectoryInvocation struct {
	Id         string          `json:"id"`
	Model      string          `json:"model"`
	Purpose    string          `json:"purpose"`
	DurationMs int64           `json:"durationMs"`
	Usage      trajectoryUsage `json:"usage"`
	Cost       float64         `json:"cost"`
}

type trajectoryTurn struct {
	Id           string                 `json:"id"`
	Index        int                    `json:"index"`
	StartedAt    int64                  `json:"startedAt"`
	EndedAt      int64                  `json:"endedAt"`
	DurationMs   int64                  `json:"durationMs"`
	Status       string                 `json:"status"`
	Model        string                 `json:"model"`
	Usage        trajectoryUsage        `json:"usage"`
	Cost         float64                `json:"cost"`
	CacheHitRate float64                `json:"cacheHitRate"`
	ToolCalls    []trajectoryTool       `json:"toolCalls"`
	Invocations  []trajectoryInvocation `json:"invocations"`
}

type trajectoryToolStat struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Ms     int64  `json:"ms"`
	Errors int    `json:"errors"`
}

type trajectoryTiming struct {
	WallMs  int64 `json:"wallMs"`
	TtftMs  int64 `json:"ttftMs"`
	GenMs   int64 `json:"genMs"`
	ToolMs  int64 `json:"toolMs"`
	OtherMs int64 `json:"otherMs"`
}

type trajectoryContext struct {
	LastTokens int64 `json:"lastTokens"`
	PeakTokens int64 `json:"peakTokens"`
}

type trajectoryTotals struct {
	Turns        int                  `json:"turns"`
	Requests     int                  `json:"requests"`
	ModelReplies int                  `json:"modelReplies"`
	UserMessages int                  `json:"userMessages"`
	ToolMessages int                  `json:"toolMessages"`
	Compactions  int                  `json:"compactions"`
	ToolCalls    int                  `json:"toolCalls"`
	ToolErrors   int                  `json:"toolErrors"`
	Input        int64                `json:"input"`
	Output       int64                `json:"output"`
	CacheRead    int64                `json:"cacheRead"`
	CacheWrite   int64                `json:"cacheWrite"`
	TotalTokens  int64                `json:"totalTokens"`
	Cost         float64              `json:"cost"`
	DurationMs   int64                `json:"durationMs"`
	CacheHitRate float64              `json:"cacheHitRate"`
	ToolsByName  []trajectoryToolStat `json:"toolsByName"`
	Timing       trajectoryTiming     `json:"timing"`
	Context      trajectoryContext    `json:"context"`
	Commands     []trajectoryCommand  `json:"commands"`
	Paths        []trajectoryPath     `json:"paths"`
	Files        trajectoryFiles      `json:"files"`
}

type trajectoryRequest struct {
	Id            string                 `json:"id"`
	Composition   *trajectoryComposition `json:"composition,omitempty"`
	Model         string                 `json:"model"`
	At            int64                  `json:"at"`
	ContextTokens int64                  `json:"contextTokens"`
	Input         int64                  `json:"input"`
	Output        int64                  `json:"output"`
	CacheRead     int64                  `json:"cacheRead"`
	CacheWrite    int64                  `json:"cacheWrite"`
	DurationMs    int64                  `json:"durationMs"`
}

type trajectoryEvent struct {
	At     int64  `json:"at"`
	Type   string `json:"type"`
	Text   string `json:"text"`
	Tokens int64  `json:"tokens"`
}

type trajectoryCommand struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Errors int    `json:"errors"`
}

type trajectoryPath struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type trajectoryFiles struct {
	Read   int `json:"read"`
	Write  int `json:"write"`
	Search int `json:"search"`
	Image  int `json:"image"`
}

type trajectoryAgent struct {
	TaskId   string  `json:"taskId"`
	NodeId   string  `json:"nodeId"`
	Role     string  `json:"role"`
	Instance string  `json:"instance"`
	Model    string  `json:"model"`
	Requests int     `json:"requests"`
	Tokens   int64   `json:"tokens"`
	Cost     float64 `json:"cost"`
}

type trajectoryComposition struct {
	SystemPrompt    int64 `json:"systemPrompt"`
	ToolDefinitions int64 `json:"toolDefinitions"`
	UserMessages    int64 `json:"userMessages"`
	AssistantReply  int64 `json:"assistantReply"`
	ToolCalls       int64 `json:"toolCalls"`
	Injected        int64 `json:"injected"`
	Reasoning       int64 `json:"reasoning"`
}

type conversationTrajectory struct {
	ConversationId string                `json:"conversationId"`
	TaskId         string                `json:"taskId"`
	Turns          []trajectoryTurn      `json:"turns"`
	Requests       []trajectoryRequest   `json:"requests"`
	RequestOffset  int                   `json:"requestOffset"`
	Events         []trajectoryEvent     `json:"events"`
	Totals         trajectoryTotals      `json:"totals"`
	Composition    trajectoryComposition `json:"composition"`
	Agents         []trajectoryAgent     `json:"agents"`
}

type trajectoryState struct {
	loadState[conversationTrajectory]
	scopeKey string
	selected int
}

func (s *shellState) ensureTrajectory() {
	if s.conversationDataBlocked() {
		return
	}
	scope := s.chatScope()
	path, key := trajectoryEndpoint(scope)
	state := &s.trajectory
	if path == "" {
		state.reset()
		state.scopeKey = ""
		state.selected = 0
		state.failed = "先打开一个会话"
		return
	}
	if state.scopeKey != key {
		state.reset()
		state.scopeKey = key
		state.selected = 0
	}
	if state.data == nil {
		s.boardScrollTop = true
	}
	s.startTrajectory(path, false)
}

func (s *shellState) trajectoryVisible() bool {
	if s.activeBoardKind() == "trajectory" {
		return true
	}
	for _, kind := range []string{"trajectory", "context-overview"} {
		if s.panelOf(kind) != nil {
			return true
		}
	}
	return false
}

func (s *shellState) refreshTrajectory() {
	if !s.trajectoryVisible() {
		return
	}
	path, key := trajectoryEndpoint(s.chatScope())
	state := &s.trajectory
	if path == "" || state.data == nil || state.scopeKey != key || state.loading() {
		return
	}
	s.startTrajectory(path, true)
}

// refreshTrajectoryAfterReset re-reads the card even when nothing else moved.
// A reset discards the model context without writing a message, so the payload
// the card describes changed while the transcript it was keyed to did not.
func (s *shellState) refreshTrajectoryAfterReset() {
	state := &s.trajectory
	path, key := trajectoryEndpoint(s.chatScope())
	if path == "" || state.data == nil || state.scopeKey != key {
		return
	}
	s.startTrajectory(path, true)
}

func (s *shellState) startTrajectory(path string, keepSelection bool) {
	state := &s.trajectory
	var generation int
	var start bool
	if keepSelection {
		generation, start = state.beginRefresh()
	} else {
		generation, start = state.begin()
	}
	if !start {
		return
	}
	api := s.api
	go func() {
		payload, err := api.get(path)
		var data *conversationTrajectory
		failure := ""
		if err != nil {
			failure = readFailureText(err, "轨迹")
		} else if err := json.Unmarshal(payload, &data); err != nil {
			failure = "轨迹格式不对"
		}
		onUI(s.window, func() {
			if state.settle(generation, data, failure) && data != nil {
				if keepSelection {
					if state.selected < 0 {
						state.selected = 0
					}
					if state.selected >= len(data.Requests) {
						state.selected = len(data.Requests) - 1
					}
				} else {
					state.selected = len(data.Requests) - 1
				}
			}
		})
		s.frame()
	}()
}

func trajectoryRequestTotal(data *conversationTrajectory) int {
	if data == nil {
		return 0
	}
	return data.RequestOffset + len(data.Requests)
}

func trajectoryEndpoint(scope chatScope) (string, string) {
	switch scope.Kind {
	case "conversation":
		return "/api/conversations/" + url.PathEscape(scope.ConversationID) + "/trajectory", scope.key()
	case "node":
		return "/api/tasks/" + url.PathEscape(scope.TaskID) + "/nodes/" + url.PathEscape(scope.NodeID) + "/trajectory", scope.key()
	}
	return "", ""
}

func formatTrajectoryTokens(tokens int64) string {
	switch {
	case tokens >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(tokens)/1_000_000)
	case tokens >= 1_000:
		return fmt.Sprintf("%.1fk", float64(tokens)/1_000)
	}
	return strconv.FormatInt(tokens, 10)
}

func formatTrajectoryDuration(ms int64) string {
	switch {
	case ms >= 60_000:
		return fmt.Sprintf("%dm %02ds", ms/60_000, (ms%60_000)/1_000)
	case ms >= 1_000:
		return fmt.Sprintf("%.1fs", float64(ms)/1_000)
	}
	return strconv.FormatInt(ms, 10) + "ms"
}

func formatTrajectoryClock(at int64) string {
	if at <= 0 {
		return "—"
	}
	return time.UnixMilli(at).Format("01-02 15:04")
}

func formatTrajectoryCompactTokens(tokens int64) string {
	switch {
	case tokens >= 1_000_000_000:
		return fmt.Sprintf("%.1fB", float64(tokens)/1_000_000_000)
	case tokens >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(tokens)/1_000_000)
	case tokens >= 1_000:
		return fmt.Sprintf("%.1fk", float64(tokens)/1_000)
	}
	return strconv.FormatInt(tokens, 10)
}

func formatTrajectoryCompactDuration(ms int64) string {
	if ms >= 24*3600_000 {
		return fmt.Sprintf("%.1fd", float64(ms)/(24*3600_000))
	}
	if ms >= 3600_000 {
		return fmt.Sprintf("%.1fh", float64(ms)/3600_000)
	}
	if ms >= 60_000 {
		return fmt.Sprintf("%dm", ms/60_000)
	}
	if ms >= 1_000 {
		return fmt.Sprintf("%.1fs", float64(ms)/1_000)
	}
	return strconv.FormatInt(ms, 10) + "ms"
}

func formatTrajectoryCost(cost float64) string {
	if cost == 0 {
		return "$0"
	}
	if cost < 0.01 {
		return fmt.Sprintf("$%.4f", cost)
	}
	return fmt.Sprintf("$%.3f", cost)
}

func formatTrajectoryPercent(rate float64) string {
	return strconv.FormatFloat(rate*100, 'f', 1, 64) + "%"
}

func trajectoryToolNames(tools []trajectoryTool) string {
	if len(tools) == 0 {
		return ""
	}
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	return joinToolNames(names)
}

func joinToolNames(names []string) string {
	out := ""
	for index, name := range names {
		if index > 0 {
			out += " · "
		}
		out += name
	}
	return out
}
