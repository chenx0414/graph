package graph

import (
	"database/sql"
)

// ToolCallStat is one tool/role aggregate. Role is JSON null when the call had no role.
type ToolCallStat struct {
	Tool     string  `json:"tool"`
	Role     *string `json:"role"`
	Calls    int64   `json:"calls"`
	Errors   int64   `json:"errors"`
	TotalMs  int64   `json:"totalMs"`
	MedianMs float64 `json:"medianMs"`
	MaxMs    int64   `json:"maxMs"`
	LastAt   int64   `json:"lastAt"`
}

func (s *TaskStore) ToolCallStats(keepDays ...int) []ToolCallStat {
	days := ToolCallRetentionDays
	if len(keepDays) > 0 {
		days = keepDays[0]
	}
	s.PruneToolCalls(days)
	rows, err := s.DB.Query(`WITH ranked AS (
         SELECT tool, role, ms, is_error, created_at,
           row_number() OVER (PARTITION BY tool, role ORDER BY ms, id) AS ordinal,
           count(*) OVER (PARTITION BY tool, role) AS sample_count
         FROM tool_calls
       )
       SELECT tool, role, count(*) AS calls, sum(is_error) AS errors,
         sum(ms) AS total_ms,
         avg(CASE WHEN ordinal IN ((sample_count + 1) / 2, (sample_count + 2) / 2) THEN ms END) AS median_ms,
         max(ms) AS max_ms, max(created_at) AS last_at
       FROM ranked GROUP BY tool, role ORDER BY calls DESC, tool`)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []ToolCallStat{}
	for rows.Next() {
		var stat ToolCallStat
		var role sql.NullString
		var calls, errors, total, maxMs, last sql.NullInt64
		var median sql.NullFloat64
		if err := rows.Scan(&stat.Tool, &role, &calls, &errors, &total, &median, &maxMs, &last); err != nil {
			panic(err)
		}
		if role.Valid {
			value := role.String
			stat.Role = &value
		}
		stat.Calls = calls.Int64
		stat.Errors = errors.Int64
		stat.TotalMs = total.Int64
		stat.MedianMs = median.Float64
		stat.MaxMs = maxMs.Int64
		stat.LastAt = last.Int64
		out = append(out, stat)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}
