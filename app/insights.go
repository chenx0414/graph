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
	loadState[trajectoryInsights]
	days int
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
	s.insights.reset()
	s.ensureInsights()
}

func (s *shellState) ensureInsights() {
	state := &s.insights
	generation, start := state.begin()
	if !start {
		return
	}
	days := s.insightsDays()
	go func() {
		payload, err := s.api.get("/api/trajectory/insights?days=" + strconv.Itoa(days))
		var data *trajectoryInsights
		failure := ""
		if err != nil {
			failure = "读不到洞察：" + err.Error()
		} else if err := json.Unmarshal(payload, &data); err != nil {
			failure = "洞察格式不对"
		}
		if state.settle(generation, data, failure) {
			s.frame()
		}
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
