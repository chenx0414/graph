package graph

import (
	"encoding/json"
	"sort"
	"time"
)

type TrajectoryDay struct {
	Date         string  `json:"date"`
	Requests     int     `json:"requests"`
	Tokens       int64   `json:"tokens"`
	Cost         float64 `json:"cost"`
	CacheHitRate float64 `json:"cacheHitRate"`
}

type TrajectoryInsightTotals struct {
	Requests     int     `json:"requests"`
	Tokens       int64   `json:"tokens"`
	Cost         float64 `json:"cost"`
	CacheHitRate float64 `json:"cacheHitRate"`
	Sessions     int     `json:"sessions"`
}

type TrajectorySession struct {
	ConversationId string  `json:"conversationId"`
	Title          string  `json:"title"`
	Requests       int     `json:"requests"`
	Tokens         int64   `json:"tokens"`
	Cost           float64 `json:"cost"`
	LastAt         int64   `json:"lastAt"`
}

type TrajectoryInsights struct {
	Days     []TrajectoryDay         `json:"days"`
	Totals   TrajectoryInsightTotals `json:"totals"`
	Sessions []TrajectorySession     `json:"sessions"`
}

func BuildTrajectoryInsights(store *TaskStore, days int) *TrajectoryInsights {
	if days <= 0 {
		days = 7
	}
	if days > 30 {
		days = 30
	}
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))
	insights := &TrajectoryInsights{}
	byDay := map[string]*TrajectoryDay{}
	dayCacheRead := map[string]int64{}
	dayInput := map[string]int64{}
	for index := 0; index < days; index++ {
		day := start.AddDate(0, 0, index)
		key := day.Format("2006-01-02")
		entry := &TrajectoryDay{Date: key}
		byDay[key] = entry
		insights.Days = append(insights.Days, *entry)
	}
	rows := kernelRows(store.Db, `SELECT i.usage,i.cost,COALESCE(i.dispatched_at,0) AS dispatched_at,
		COALESCE(t.conversation_id,'') AS conversation_id,COALESCE(c.title,'') AS title
		FROM invocations i JOIN operations o ON o.id=i.operation_id
		LEFT JOIN tasks t ON t.id=o.task_id
		LEFT JOIN conversations c ON c.id=t.conversation_id
		WHERE i.dispatched_at>=?`, start.UnixMilli())
	type sessionAggregate struct {
		requests int
		tokens   int64
		cost     float64
		lastAt   int64
		title    string
	}
	sessions := map[string]*sessionAggregate{}
	cacheReadTotal, inputTotal := int64(0), int64(0)
	for _, row := range rows {
		at := kernelInt(row["dispatched_at"])
		tokens := int64(0)
		cacheRead := int64(0)
		input := int64(0)
		if recorded, ok := row["usage"].(string); ok && recorded != "" {
			var usage TokenUsage
			if json.Unmarshal([]byte(recorded), &usage) == nil {
				value := trajectoryUsage(usage)
				tokens = value.Total
				cacheRead = value.CacheRead
				input = value.Input
			}
		}
		cost := trajectoryCost(row["cost"])
		dayKey := time.UnixMilli(at).Format("2006-01-02")
		if day, ok := byDay[dayKey]; ok {
			day.Requests++
			day.Tokens += tokens
			day.Cost += cost
		}
		dayCacheRead[dayKey] += cacheRead
		dayInput[dayKey] += input
		cacheReadTotal += cacheRead
		inputTotal += input
		insights.Totals.Requests++
		insights.Totals.Tokens += tokens
		insights.Totals.Cost += cost
		conversationID := kernelString(row["conversation_id"])
		if conversationID == "" {
			continue
		}
		aggregate := sessions[conversationID]
		if aggregate == nil {
			aggregate = &sessionAggregate{title: kernelString(row["title"])}
			sessions[conversationID] = aggregate
		}
		aggregate.requests++
		aggregate.tokens += tokens
		aggregate.cost += cost
		if at > aggregate.lastAt {
			aggregate.lastAt = at
		}
		if aggregate.title == "" {
			aggregate.title = kernelString(row["title"])
		}
	}
	for index := range insights.Days {
		key := insights.Days[index].Date
		if day, ok := byDay[key]; ok {
			insights.Days[index] = *day
			insights.Days[index].CacheHitRate = trajectoryCacheHitRate(TrajectoryUsage{Input: dayInput[key], CacheRead: dayCacheRead[key]})
		}
	}
	insights.Totals.CacheHitRate = trajectoryCacheHitRate(TrajectoryUsage{Input: inputTotal, CacheRead: cacheReadTotal})
	insights.Totals.Sessions = len(sessions)
	for conversationID, aggregate := range sessions {
		insights.Sessions = append(insights.Sessions, TrajectorySession{
			ConversationId: conversationID, Title: aggregate.title, Requests: aggregate.requests,
			Tokens: aggregate.tokens, Cost: aggregate.cost, LastAt: aggregate.lastAt,
		})
	}
	sort.SliceStable(insights.Sessions, func(first, second int) bool {
		return insights.Sessions[first].Cost > insights.Sessions[second].Cost
	})
	if len(insights.Sessions) > 8 {
		insights.Sessions = insights.Sessions[:8]
	}
	return insights
}
