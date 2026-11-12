package graph

import (
	"encoding/json"
	"strings"
)

func trajectoryUsage(usage TokenUsage) TrajectoryUsage {
	value := TrajectoryUsage{
		Input:      usage.Input,
		Output:     usage.Output,
		CacheRead:  usage.CacheRead,
		CacheWrite: usage.CacheWrite,
		Total:      usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite,
	}
	if usage.ContextTokens != nil {
		value.ContextTokens = *usage.ContextTokens
	}
	if usage.FirstTokenMs != nil {
		value.FirstTokenMs = *usage.FirstTokenMs
	}
	if usage.DurationMs != nil {
		value.DurationMs = *usage.DurationMs
	}
	return value
}

func addTrajectoryUsage(base, extra TrajectoryUsage) TrajectoryUsage {
	return TrajectoryUsage{
		Input:      base.Input + extra.Input,
		Output:     base.Output + extra.Output,
		CacheRead:  base.CacheRead + extra.CacheRead,
		CacheWrite: base.CacheWrite + extra.CacheWrite,
		Total:      base.Total + extra.Total,
	}
}

func trajectoryCacheHitRate(usage TrajectoryUsage) float64 {
	denominator := usage.Input + usage.CacheRead
	if denominator == 0 {
		return 0
	}
	return float64(usage.CacheRead) / float64(denominator)
}

func trajectoryToolStats(tools []TrajectoryTool) []TrajectoryToolStat {
	stats := []TrajectoryToolStat{}
	index := map[string]int{}
	for _, tool := range tools {
		position, ok := index[tool.Name]
		if !ok {
			index[tool.Name] = len(stats)
			stats = append(stats, TrajectoryToolStat{Name: tool.Name})
			position = len(stats) - 1
		}
		stats[position].Count++
		stats[position].Ms += tool.Ms
		if tool.IsError {
			stats[position].Errors++
		}
	}
	return stats
}

func trajectoryTotals(turns []TrajectoryTurn) TrajectoryTotals {
	totals := TrajectoryTotals{Turns: len(turns)}
	for _, turn := range turns {
		totals.ToolCalls += len(turn.ToolCalls)
		for _, tool := range turn.ToolCalls {
			if tool.IsError {
				totals.ToolErrors++
			}
		}
		totals.Input += turn.Usage.Input
		totals.Output += turn.Usage.Output
		totals.CacheRead += turn.Usage.CacheRead
		totals.CacheWrite += turn.Usage.CacheWrite
		totals.TotalTokens += turn.Usage.Total
		totals.Cost += turn.Cost
		totals.DurationMs += turn.DurationMs
	}
	totals.CacheHitRate = trajectoryCacheHitRate(TrajectoryUsage{Input: totals.Input, CacheRead: totals.CacheRead})
	return totals
}

func trajectoryCost(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case int64:
		return float64(typed)
	case string:
		return trajectoryCostJSON([]byte(typed))
	case []byte:
		return trajectoryCostJSON(typed)
	}
	return 0
}

func trajectoryCostJSON(payload []byte) float64 {
	var decoded any
	if json.Unmarshal(payload, &decoded) != nil {
		return 0
	}
	switch typed := decoded.(type) {
	case float64:
		return typed
	case map[string]any:
		for _, key := range []string{"total", "amount", "usd", "cost"} {
			if value, ok := typed[key]; ok {
				if amount := trajectoryCost(value); amount > 0 {
					return amount
				}
			}
		}
		sum := 0.0
		for key, value := range typed {
			if strings.TrimSpace(key) == "" {
				continue
			}
			sum += trajectoryCost(value)
		}
		return sum
	}
	return 0
}
