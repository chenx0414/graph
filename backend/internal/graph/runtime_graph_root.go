package graph

import (
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"bytes"

	"crypto/rand"
)

// GraphApplicationRoot is graphApplicationRoot. With no module URL it returns
// ApplicationRoot once the CLI has set it.
func GraphApplicationRoot(moduleURL ...string) string {
	if len(moduleURL) == 0 || moduleURL[0] == "" {
		if ApplicationRoot != "" {
			return ApplicationRoot
		}
		// TODO(port): TypeScript defaults moduleUrl to import.meta.url. Go has no
		// module URL, so an unset ApplicationRoot falls back to the working directory.
		cwd, err := os.Getwd()
		if err != nil {
			panic(err)
		}
		return cwd
	}
	loc := moduleURL[0]
	if strings.HasPrefix(loc, "file:") {
		parsed, err := url.Parse(loc)
		if err != nil {
			panic(err)
		}
		loc = parsed.Path
	}
	abs, err := filepath.Abs(loc)
	if err != nil {
		panic(err)
	}
	return filepath.Clean(filepath.Join(filepath.Dir(abs), "..", ".."))
}

func sqliteRows(db *sql.DB, query string, args ...any) []map[string]any {
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
			row[col] = sqliteScalar(dest[i])
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func sqliteOne(db *sql.DB, query string, args ...any) (map[string]any, bool) {
	rows := sqliteRows(db, query, args...)
	if len(rows) == 0 {
		return nil, false
	}
	return rows[0], true
}

func sqliteChanges(db *sql.DB, query string, args ...any) int64 {
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

func sqliteScalar(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	default:
		return t
	}
}

func sqlString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []byte:
		return string(t)
	default:
		return ""
	}
}

func sqlInt(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case int32:
		return int64(t)
	case float64:
		return int64(t)
	case json.Number:
		n, _ := t.Int64()
		return n
	default:
		return 0
	}
}

func sqlFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case json.Number:
		n, _ := t.Float64()
		return n
	default:
		return 0
	}
}

// stringifyJSON is JSON.stringify: no HTML escaping, trailing newline stripped.
// nil encodes as null. A nil map encodes as null, matching JSON.stringify(undefined)
// only when the caller passes the undefined sentinel instead.
func stringifyJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

func tryParseJSON(text string) (v any, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
			v = nil
		}
	}()
	return parseJSON(text), true
}

func parseJSON(text string) any {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		panic(err)
	}
	return normalizeParsed(v)
}

func normalizeParsed(v any) any {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil && strconvSafe(i) {
			return float64(i)
		}
		f, err := t.Float64()
		if err != nil {
			panic(err)
		}
		return f
	case []any:
		for i := range t {
			t[i] = normalizeParsed(t[i])
		}
		return t
	case map[string]any:
		for k, child := range t {
			t[k] = normalizeParsed(child)
		}
		return t
	default:
		return v
	}
}

func strconvSafe(i int64) bool {
	return i >= -9007199254740991 && i <= 9007199254740991
}

func safeInteger(n float64) bool {
	if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) {
		return false
	}
	return n >= -9007199254740991 && n <= 9007199254740991
}

func safeIntegerAny(v any) bool {
	switch t := v.(type) {
	case float64:
		return safeInteger(t)
	case int:
		return safeInteger(float64(t))
	case int64:
		return safeInteger(float64(t))
	case json.Number:
		f, err := t.Float64()
		return err == nil && safeInteger(f)
	default:
		return false
	}
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

func asMap(v any) map[string]any {
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil || string(raw) == "null" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

func asSlice(v any) []any {
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil || string(raw) == "null" {
		return nil
	}
	var out []any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func mapString(m map[string]any, keys ...string) string {
	if m == nil {
		return ""
	}
	for _, key := range keys {
		if s, ok := m[key].(string); ok {
			return s
		}
	}
	return ""
}

func mapHas(m map[string]any, keys ...string) bool {
	if m == nil {
		return false
	}
	for _, key := range keys {
		if _, ok := m[key]; ok {
			return true
		}
	}
	return false
}

func encodeURIComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || strings.ContainsRune("-_.!~*'()", r) {
			b.WriteRune(r)
			continue
		}
		buf := []byte(string(r))
		for _, c := range buf {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func withStoreTx(store *TaskStore, apply func() any) any {
	if store.InTransaction() {
		return apply()
	}
	return store.Transaction(apply)
}
