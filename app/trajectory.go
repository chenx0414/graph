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
	Events         []trajectoryEvent     `json:"events"`
	Totals         trajectoryTotals      `json:"totals"`
	Composition    trajectoryComposition `json:"composition"`
	Agents         []trajectoryAgent     `json:"agents"`
}

type trajectoryState struct {
	scopeKey string
	loading  bool
	failed   string
	data     *conversationTrajectory
	selected int
}

func (s *shellState) ensureTrajectory() {
	scope := s.chatScope()
	path, key := trajectoryEndpoint(scope)
	state := &s.trajectory
	if path == "" {
		state.failed = "先打开一个会话"
		return
	}
	if state.scopeKey != key {
		state.data = nil
		state.selected = 0
		state.failed = ""
	}
	if state.data == nil {
		s.boardScrollTop = true
	}
	if state.loading || (state.data != nil && state.scopeKey == key) {
		return
	}
	state.loading = true
	state.failed = ""
	state.scopeKey = key
	go func() {
		payload, err := s.api.get(path)
		if err != nil {
			state.failed = "读不到轨迹：" + err.Error()
			state.loading = false
			s.frame()
			return
		}
		var data conversationTrajectory
		if err := json.Unmarshal(payload, &data); err != nil {
			state.failed = "轨迹格式不对"
			state.loading = false
			s.frame()
			return
		}
		state.data = &data
		state.selected = len(data.Requests) - 1
		state.failed = ""
		state.loading = false
		s.frame()
	}()
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
