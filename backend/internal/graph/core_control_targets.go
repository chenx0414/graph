package graph

import (
	"encoding/json"
	"fmt"

	"database/sql"
)

// ActiveOperation is the turn actually running on a node.
type ActiveOperation struct {
	Id string
}

// ActiveOperationForNode returns the dispatched operation a steering message must reach.
func ActiveOperationForNode(store *TaskStore, taskID, nodeID string) *ActiveOperation {
	row, ok := g5One(store.Db, `SELECT id FROM operations
    WHERE task_id=? AND node_id=? AND state='dispatched' AND worker_active=1
    ORDER BY rowid DESC LIMIT 1`, taskID, nodeID)
	if !ok {
		return nil
	}
	return &ActiveOperation{Id: g5Str(row["id"])}
}

func g5Query(db *sql.DB, query string, args ...any) []map[string]any {
	rows, err := db.Query(query, args...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		panic(err)
	}
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = g5Norm(vals[i])
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func g5One(db *sql.DB, query string, args ...any) (map[string]any, bool) {
	rows := g5Query(db, query, args...)
	if len(rows) == 0 {
		return nil, false
	}
	return rows[0], true
}

func g5Exec(db *sql.DB, query string, args ...any) (changes, lastID int64) {
	res, err := db.Exec(query, args...)
	if err != nil {
		panic(err)
	}
	changes, err = res.RowsAffected()
	if err != nil {
		panic(err)
	}
	lastID, err = res.LastInsertId()
	if err != nil {
		panic(err)
	}
	return changes, lastID
}

func g5Norm(value any) any {
	if text, ok := value.([]byte); ok {
		return string(text)
	}
	return value
}

func g5Str(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func g5Int(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	default:
		return 0
	}
}

func g5SafeInt(value int64) bool {
	const max int64 = 9007199254740991
	return value >= -max && value <= max
}

func g5JSON(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		var parsed any
		if err := json.Unmarshal([]byte(typed), &parsed); err != nil {
			panic(err)
		}
		return parsed
	default:
		return value
	}
}
