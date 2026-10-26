package graph

import (
	"encoding/json"
	"sort"
	"strings"

	"bytes"
)

// CanonicalJSON is src/core/store.ts canonicalJson: objects key-sorted, undefined
// dropped, non-finite numbers rejected. The idempotency command log compares this.
func CanonicalJSON(value any) string {
	normalized := normalizeJSON(value)
	// JSON.stringify does not escape <, > and &. The digest of a stored body
	// must match the TypeScript digest, so the encoder keeps them literal.
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(normalized); err != nil {
		Raise("invalid_input", "Expected JSON data")
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

func normalizeJSON(item any) any {
	switch v := item.(type) {
	case nil:
		return nil
	case string, bool:
		return v
	case int:
		return v
	case int64:
		return v
	case float64:
		if v != v || v > 1.7976931348623157e308 || v < -1.7976931348623157e308 {
			Raise("invalid_input", "Expected JSON data")
		}
		return v
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			Raise("invalid_input", "Expected JSON data")
		}
		return normalizeJSON(f)
	case []any:
		out := make([]any, len(v))
		for i := range v {
			out[i] = normalizeJSON(v[i])
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key, child := range v {
			if child == nil && !mapHasNil(v, key) {
				continue
			}
			// TypeScript dropped undefined. A missing map entry is the same.
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(keys))
		for _, key := range keys {
			child := v[key]
			if _, ok := child.(undefined); ok {
				continue
			}
			out[key] = normalizeJSON(child)
		}
		return out
	default:
		// Structs and typed slices go through encoding/json so the canonical
		// form sees plain JSON values, then key-sorts objects.
		raw, err := json.Marshal(v)
		if err != nil {
			Raise("invalid_input", "Expected JSON data")
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var decoded any
		if err := dec.Decode(&decoded); err != nil {
			Raise("invalid_input", "Expected JSON data")
		}
		return normalizeJSON(decoded)
	}
}

// undefined marks a value canonical JSON must drop, the way TypeScript dropped undefined.
type undefined struct{}

func mapHasNil(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}
