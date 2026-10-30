package graph

import (
	"database/sql"
	"strings"
)

// InsightsSummary is the one page that answers "what did this installation spend".
//
// Everything here is folded from what the installation already recorded: the
// provider calls carry the billed token buckets and their cost, the tool calls
// carry the tool side of the same work. Nothing is estimated, so a number on the
// page can always be traced back to rows.
type InsightsSummary struct {
	GeneratedAt int64              `json:"generatedAt"`
	Scope       InsightsScope      `json:"scope"`
	Overview    InsightsOverview   `json:"overview"`
	Tokens      InsightsTokens     `json:"tokens"`
	Timing      InsightsTiming     `json:"timing"`
	Models      []InsightsModelRow `json:"models"`
	Tools       []ToolCallStat     `json:"tools"`
}

// InsightsScope says which slice of the record was folded.
type InsightsScope struct {
	Kind  string `json:"kind"`
	ID    string `json:"id,omitempty"`
	Label string `json:"label,omitempty"`
}

type InsightsOverview struct {
	Turns      int64 `json:"turns"`
	Steps      int64 `json:"steps"`
	ToolCalls  int64 `json:"toolCalls"`
	ToolErrors int64 `json:"toolErrors"`
	CostMicros int64 `json:"costMicros"`
}

// InsightsTokens is the disjoint bucket total the provider reported.
type InsightsTokens struct {
	Input        int64   `json:"input"`
	Output       int64   `json:"output"`
	CacheRead    int64   `json:"cacheRead"`
	CacheWrite   int64   `json:"cacheWrite"`
	Total        int64   `json:"total"`
	CacheHitRate float64 `json:"cacheHitRate"`
}

// InsightsTiming splits wall time into the two things that took it.
type InsightsTiming struct {
	ModelMs    int64 `json:"modelMs"`
	ModelCalls int64 `json:"modelCalls"`
	ToolMs     int64 `json:"toolMs"`
	ToolCalls  int64 `json:"toolCalls"`
}

// InsightsModelRow is one billed model.
type InsightsModelRow struct {
	Model      string  `json:"model"`
	Provider   string  `json:"provider"`
	Calls      int64   `json:"calls"`
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cacheRead"`
	CacheWrite int64   `json:"cacheWrite"`
	CostMicros int64   `json:"costMicros"`
	AvgMs      float64 `json:"avgMs"`
}

// InsightsScopeFilter turns a scope into the task-id predicate both tables share.
//
// The two tables that carry the record are keyed by task, so a project or a
// conversation scope is the set of tasks that belong to it. A scope that names
// nothing is the whole installation, which is what the page opens on.
func InsightsScopeFilter(scope InsightsScope) (string, []any) {
	switch scope.Kind {
	case "project":
		if strings.TrimSpace(scope.ID) == "" {
			return "", nil
		}
		return "task_id IN (SELECT id FROM tasks WHERE project_id = ?)", []any{scope.ID}
	case "conversation":
		if strings.TrimSpace(scope.ID) == "" {
			return "", nil
		}
		return "task_id IN (SELECT id FROM tasks WHERE conversation_id = ?)", []any{scope.ID}
	}
	return "", nil
}

func whereClause(filter string, extra ...string) string {
	parts := []string{}
	if strings.TrimSpace(filter) != "" {
		parts = append(parts, filter)
	}
	parts = append(parts, extra...)
	if len(parts) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(parts, " AND ")
}

// Insights folds the record for one scope.
func (s *TaskStore) Insights(scope InsightsScope) InsightsSummary {
	filter, args := InsightsScopeFilter(scope)
	summary := InsightsSummary{GeneratedAt: NowMillis(), Scope: scope, Models: []InsightsModelRow{}, Tools: []ToolCallStat{}}
	summary.Tokens, summary.Overview, summary.Timing = s.insightProviderTotals(filter, args)
	summary.Models = s.insightModelRows(filter, args)
	summary.Tools = s.ToolCallStatsFor(filter, args)
	for _, tool := range summary.Tools {
		summary.Overview.ToolCalls += tool.Calls
		summary.Overview.ToolErrors += tool.Errors
		summary.Timing.ToolMs += tool.TotalMs
		summary.Timing.ToolCalls += tool.Calls
	}
	summary.Overview.Turns = s.insightTurns(scope)
	return summary
}

// insightProviderTotals folds the billed buckets and the model wall time.
//
// A row without a usage is a reservation that never settled: it still counts as
// a step and as elapsed time, because the wait happened, but it adds no tokens.
func (s *TaskStore) insightProviderTotals(filter string, args []any) (InsightsTokens, InsightsOverview, InsightsTiming) {
	tokens := InsightsTokens{}
	overview := InsightsOverview{}
	timing := InsightsTiming{}
	query := `SELECT
        count(*),
        coalesce(sum(cast(json_extract(usage,'$.input') as integer)),0),
        coalesce(sum(cast(json_extract(usage,'$.output') as integer)),0),
        coalesce(sum(cast(json_extract(usage,'$.cacheRead') as integer)),0),
        coalesce(sum(cast(json_extract(usage,'$.cacheWrite') as integer)),0),
        coalesce(sum(cast(json_extract(cost,'$.amount') as real)),0),
        coalesce(sum(CASE WHEN settled_at IS NOT NULL AND settled_at > created_at THEN settled_at - created_at ELSE 0 END),0),
        coalesce(sum(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END),0)
      FROM kernel_provider_calls` + whereClause(filter)
	var cost float64
	_ = s.DB.QueryRow(query, args...).Scan(
		&overview.Steps, &tokens.Input, &tokens.Output, &tokens.CacheRead, &tokens.CacheWrite,
		&cost, &timing.ModelMs, &timing.ModelCalls)
	tokens.Total = tokens.Input + tokens.Output + tokens.CacheRead + tokens.CacheWrite
	// The hit rate is the cached share of everything the provider had to read.
	read := tokens.Input + tokens.CacheRead
	if read > 0 {
		tokens.CacheHitRate = float64(tokens.CacheRead) / float64(read)
	}
	overview.CostMicros = int64(cost*1e6 + 0.5)
	return tokens, overview, timing
}

// insightModelRows lists the models behind the totals, most expensive first.
func (s *TaskStore) insightModelRows(filter string, args []any) []InsightsModelRow {
	query := `SELECT
        coalesce(json_extract(model,'$.identity'), json_extract(model,'$.id'), ''),
        coalesce(json_extract(model,'$.provider'), ''),
        count(*),
        coalesce(sum(cast(json_extract(usage,'$.input') as integer)),0),
        coalesce(sum(cast(json_extract(usage,'$.output') as integer)),0),
        coalesce(sum(cast(json_extract(usage,'$.cacheRead') as integer)),0),
        coalesce(sum(cast(json_extract(usage,'$.cacheWrite') as integer)),0),
        coalesce(sum(cast(json_extract(cost,'$.amount') as real)),0),
        coalesce(avg(CASE WHEN settled_at IS NOT NULL AND settled_at > created_at THEN settled_at - created_at END),0)
      FROM kernel_provider_calls` + whereClause(filter, "model IS NOT NULL") + `
      GROUP BY 1, 2 ORDER BY 8 DESC, 3 DESC`
	rows, err := s.DB.Query(query, args...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []InsightsModelRow{}
	for rows.Next() {
		row := InsightsModelRow{}
		var cost float64
		if err := rows.Scan(&row.Model, &row.Provider, &row.Calls, &row.Input, &row.Output,
			&row.CacheRead, &row.CacheWrite, &cost, &row.AvgMs); err != nil {
			panic(err)
		}
		row.CostMicros = int64(cost*1e6 + 0.5)
		out = append(out, row)
	}
	return out
}

// insightTurns counts the turns the record actually holds for the scope.
//
// A turn is one user→agent exchange, so the count is distinct turn numbers in
// the transcript, not messages: a turn carries many messages and still happened
// once.
func (s *TaskStore) insightTurns(scope InsightsScope) int64 {
	query := `SELECT count(*) FROM (SELECT DISTINCT conversation_id, turn FROM messages`
	args := []any{}
	switch scope.Kind {
	case "conversation":
		if strings.TrimSpace(scope.ID) == "" {
			return 0
		}
		query += ` WHERE conversation_id = ?`
		args = append(args, scope.ID)
	}
	query += `)`
	var turns sql.NullInt64
	_ = s.DB.QueryRow(query, args...).Scan(&turns)
	return turns.Int64
}
