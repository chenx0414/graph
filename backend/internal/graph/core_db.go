package graph

import ()

func graphDBRow(db sqlh, query string, args ...any) (map[string]any, bool) {
	rows := graphDBAll(db, query, args...)
	if len(rows) == 0 {
		return nil, false
	}
	return rows[0], true
}

func graphDBAll(db sqlh, query string, args ...any) []map[string]any {
	rows, err := db.Query(query, args...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		panic(err)
	}
	out := []map[string]any{}
	for rows.Next() {
		dest := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range dest {
			ptrs[i] = &dest[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = normalizeSQL(dest[i])
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func graphDBExec(db sqlh, query string, args ...any) int64 {
	result, err := db.Exec(query, args...)
	if err != nil {
		panic(err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		panic(err)
	}
	return n
}

func normalizeSQL(value any) any {
	switch v := value.(type) {
	case []byte:
		return string(v)
	default:
		return v
	}
}

func graphDBString(row map[string]any, key string) string {
	switch v := row[key].(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return ""
	}
}

func graphDBStringPtr(row map[string]any, key string) *string {
	if row[key] == nil {
		return nil
	}
	value := graphDBString(row, key)
	return &value
}

func graphDBInt(row map[string]any, key string) int64 {
	if row == nil {
		return 0
	}
	return asInt(row[key])
}
