package main

import (
	"encoding/json"
	"strconv"
)

type insightDay struct {
	Date         string  `json:"date"`
	Requests     int     `json:"requests"`
	Tokens       int64   `json:"tokens"`
	Cost         float64 `json:"cost"`
	CacheHitRate float64 `json:"cacheHitRate"`
}

type insightTotals struct {
	Requests     int     `json:"requests"`
	Tokens       int64   `json:"tokens"`
	Cost         float64 `json:"cost"`
	CacheHitRate float64 `json:"cacheHitRate"`
	Sessions     int     `json:"sessions"`
}

type insightSession struct {
	ConversationId string  `json:"conversationId"`
	Title          string  `json:"title"`
	Requests       int     `json:"requests"`
	Tokens         int64   `json:"tokens"`
	Cost           float64 `json:"cost"`
	LastAt         int64   `json:"lastAt"`
}

type trajectoryInsights struct {
	Days     []insightDay     `json:"days"`
	Totals   insightTotals    `json:"totals"`
	Sessions []insightSession `json:"sessions"`
}

type insightsState struct {
	loading bool
	failed  string
	days    int
	data    *trajectoryInsights
}

func (s *shellState) insightsDays() int {
	if s.insights.days == 0 {
		return 7
	}
	return s.insights.days
}

func (s *shellState) setInsightsDays(days int) {
	if s.insights.days == days {
		return
	}
	s.insights.days = days
	s.insights.data = nil
	s.insights.loading = false
	s.ensureInsights()
}

func (s *shellState) ensureInsights() {
	state := &s.insights
	if state.loading || state.data != nil {
		return
	}
	days := state.days
	if days == 0 {
		days = 7
	}
	state.loading = true
	state.failed = ""
	go func() {
		payload, err := s.api.get("/api/trajectory/insights?days=" + strconv.Itoa(days))
		if err != nil {
			state.failed = "读不到洞察：" + err.Error()
			state.loading = false
			s.frame()
			return
		}
		var data trajectoryInsights
		if err := json.Unmarshal(payload, &data); err != nil {
			state.failed = "洞察格式不对"
			state.loading = false
			s.frame()
			return
		}
		state.data = &data
		state.loading = false
		s.frame()
	}()
}

func formatInsightDate(date string) string {
	if len(date) >= 10 {
		return date[5:]
	}
	return date
}

func insightRequestsLabel(requests int) string {
	return strconv.Itoa(requests) + " 次"
}
