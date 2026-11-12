package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type modelUsage struct {
	name  string
	calls int
	cost  int64
}

type planRow struct {
	name       string
	state      string
	modelCount int
}

type capabilityTally struct {
	ready   int
	missing int
}

type usageSnapshot struct {
	turns        int
	toolCalls    int
	toolErrors   int
	costMicros   int64
	tokens       int64
	cacheHit     float64
	models       []modelUsage
	plans        []planRow
	capabilities capabilityTally
}

type insightsPayload struct {
	Overview struct {
		Turns      int   `json:"turns"`
		ToolCalls  int   `json:"toolCalls"`
		ToolErrors int   `json:"toolErrors"`
		CostMicros int64 `json:"costMicros"`
	} `json:"overview"`
	Tokens struct {
		Total        int64   `json:"total"`
		CacheHitRate float64 `json:"cacheHitRate"`
	} `json:"tokens"`
	Models []struct {
		Model      string `json:"model"`
		Provider   string `json:"provider"`
		Calls      int    `json:"calls"`
		CostMicros int64  `json:"costMicros"`
	} `json:"models"`
}

type usagePayload struct {
	Plans []struct {
		Name       string `json:"name"`
		Status     string `json:"status"`
		Configured bool   `json:"configured"`
		Models     []struct {
			ID string `json:"id"`
		} `json:"models"`
	} `json:"plans"`
}

type capabilitiesPayload struct {
	Items []struct {
		Kind  string `json:"kind"`
		Ready bool   `json:"ready"`
	} `json:"items"`
}

func parseUsage(insights, usage, capabilities []byte) (usageSnapshot, error) {
	snapshot := usageSnapshot{}
	var counted insightsPayload
	if err := json.Unmarshal(insights, &counted); err != nil {
		return snapshot, err
	}
	snapshot.turns = counted.Overview.Turns
	snapshot.toolCalls = counted.Overview.ToolCalls
	snapshot.toolErrors = counted.Overview.ToolErrors
	snapshot.costMicros = counted.Overview.CostMicros
	snapshot.tokens = counted.Tokens.Total
	snapshot.cacheHit = counted.Tokens.CacheHitRate
	for _, model := range counted.Models {
		name := model.Model
		if model.Provider != "" {
			name = model.Provider + " · " + model.Model
		}
		snapshot.models = append(snapshot.models, modelUsage{name: name, calls: model.Calls, cost: model.CostMicros})
	}
	sort.SliceStable(snapshot.models, func(a, b int) bool { return snapshot.models[a].calls > snapshot.models[b].calls })
	var planned usagePayload
	if err := json.Unmarshal(usage, &planned); err != nil {
		return snapshot, err
	}
	for _, plan := range planned.Plans {
		state := plan.Status
		if !plan.Configured {
			state = "未配置"
		}
		snapshot.plans = append(snapshot.plans, planRow{name: plan.Name, state: state, modelCount: len(plan.Models)})
	}
	var catalog capabilitiesPayload
	if err := json.Unmarshal(capabilities, &catalog); err != nil {
		return snapshot, err
	}
	for _, item := range catalog.Items {
		if item.Ready {
			snapshot.capabilities.ready++
			continue
		}
		snapshot.capabilities.missing++
	}
	return snapshot, nil
}

func formatCost(micros int64) string {
	return fmt.Sprintf("$%.2f", float64(micros)/1_000_000)
}

func formatTokens(tokens int64) string {
	switch {
	case tokens >= 1_000_000_000:
		return fmt.Sprintf("%.2fB", float64(tokens)/1_000_000_000)
	case tokens >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(tokens)/1_000_000)
	case tokens >= 1_000:
		return fmt.Sprintf("%.1fK", float64(tokens)/1_000)
	}
	return strconv.FormatInt(tokens, 10)
}

func formatPercent(rate float64) string {
	return fmt.Sprintf("%.1f%%", rate*100)
}

func errorRate(snapshot usageSnapshot) string {
	if snapshot.toolCalls == 0 {
		return "0.0%"
	}
	return formatPercent(float64(snapshot.toolErrors) / float64(snapshot.toolCalls))
}

func modelLabel(model modelUsage) string {
	return model.name + " · " + strconv.Itoa(model.calls) + " 次 · " + formatCost(model.cost)
}

func planLabel(plan planRow) string {
	return plan.name + " · " + plan.state + " · " + strconv.Itoa(plan.modelCount) + " 个模型"
}

type usageState struct {
	api    apiClient
	status string
	window *mygo.Window
	rows   usageSnapshot
	list   ui.ListState
}

func newUsageState(address, token string) *usageState {
	return &usageState{api: newAPIClient(address, token), status: "正在汇总用量…"}
}

func (s *usageState) load() {
	insights, err := s.api.get("/api/insights")
	if err != nil {
		s.status = "读不到用量：" + err.Error()
		return
	}
	usage, err := s.api.get("/api/usage")
	if err != nil {
		s.status = "读不到订阅额度：" + err.Error()
		return
	}
	capabilities, err := s.api.get("/api/capabilities/config")
	if err != nil {
		s.status = "读不到能力库：" + err.Error()
		return
	}
	snapshot, err := parseUsage(insights, usage, capabilities)
	if err != nil {
		s.status = "用量不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = snapshot
	s.status = ""
	s.frame()
}

func (s *usageState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}
