package graph

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"math"
)

// kernelContentPrefix is deliberately not JSON: a user value can never impersonate a reference.
const kernelContentPrefix = "graph-content:sha256:"

const jsMaxSafeInteger = 9007199254740991

// ContentDigest is the sha256 hex of a stored body.
func ContentDigest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// KernelContent stores immutable JSON bodies in the kernel database.
type KernelContent struct {
	db sqlDB
}

// NewKernelContent creates the content table on an existing database connection.
func NewKernelContent(db sqlDB) *KernelContent {
	kernelExec(db, `CREATE TABLE IF NOT EXISTS kernel_content(
      digest TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL, preview TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS kernel_content_immutable BEFORE UPDATE ON kernel_content
      BEGIN SELECT RAISE(ABORT, 'Kernel content is immutable'); END;`)
	return &KernelContent{db: db}
}

// Encode stores a canonical JSON body inline when it fits, otherwise by digest.
func (content *KernelContent) Encode(value any) string {
	body := CanonicalJSON(value)
	bytes := len(body)
	if bytes <= 4096 {
		return body
	}
	digest := ContentDigest(body)
	preview := body
	if len(preview) > 512 {
		preview = preview[:512]
	}
	kernelExec(content.db, "INSERT OR IGNORE INTO kernel_content(digest,body,bytes,preview) VALUES(?,?,?,?)", digest, body, bytes, preview)
	return kernelContentPrefix + digest
}

// Decode returns the JSON value stored inline or by digest.
func (content *KernelContent) Decode(stored string) any {
	if len(stored) < len(kernelContentPrefix) || stored[:len(kernelContentPrefix)] != kernelContentPrefix {
		var value any
		if err := json.Unmarshal([]byte(stored), &value); err != nil {
			panic(err)
		}
		return value
	}
	digest := stored[len(kernelContentPrefix):]
	row := kernelRow(content.db, "SELECT body FROM kernel_content WHERE digest=?", digest)
	if row == nil || ContentDigest(kernelString(row["body"])) != digest {
		Raise("invalid_content", "Missing or corrupt kernel content")
	}
	var value any
	if err := json.Unmarshal([]byte(kernelString(row["body"])), &value); err != nil {
		panic(err)
	}
	return value
}

// ContentColumn is the SQL expression that reads a content column without always fetching a large body.
func ContentColumn(column string, part ...string) string {
	which := "body"
	if len(part) > 0 && part[0] != "" {
		which = part[0]
	}
	inline := column
	if which == "bytes" {
		inline = "length(CAST(" + column + " AS BLOB))"
	} else if which == "preview" {
		inline = "substr(" + column + ",1,512)"
	}
	return "(CASE WHEN substr(" + column + ",1," + itoa(len(kernelContentPrefix)) + ")='" + kernelContentPrefix + "' THEN (SELECT c." + which + " FROM kernel_content c WHERE c.digest=substr(" + column + "," + itoa(len(kernelContentPrefix)+1) + ")) ELSE " + inline + " END)"
}

func kernelRows(db sqlDB, query string, args ...any) []map[string]any {
	rows, err := db.QueryContext(context.Background(), query, args...)
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
		raw := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		row := map[string]any{}
		for i, name := range cols {
			row[name] = kernelCell(raw[i])
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func kernelRow(db sqlDB, query string, args ...any) map[string]any {
	rows := kernelRows(db, query, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

func kernelExec(db sqlDB, query string, args ...any) sql.Result {
	result, err := db.ExecContext(context.Background(), query, args...)
	if err != nil {
		panic(err)
	}
	return result
}

func kernelChanges(db sqlDB, query string, args ...any) int64 {
	n, err := kernelExec(db, query, args...).RowsAffected()
	if err != nil {
		panic(err)
	}
	return n
}

func kernelCell(value any) any {
	if text, ok := value.([]byte); ok {
		return string(text)
	}
	return value
}

func kernelString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return ""
	}
}

func kernelInt(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}

func jsSafeInteger(value any) bool {
	switch typed := value.(type) {
	case int:
		return int64(typed) >= -jsMaxSafeInteger && int64(typed) <= jsMaxSafeInteger
	case int64:
		return typed >= -jsMaxSafeInteger && typed <= jsMaxSafeInteger
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0) && typed == math.Trunc(typed) && typed >= -float64(jsMaxSafeInteger) && typed <= float64(jsMaxSafeInteger)
	case json.Number:
		number, err := typed.Float64()
		return err == nil && jsSafeInteger(number)
	default:
		return false
	}
}
