package graph

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// usageRecord returns the value as a plain object, or nil.
func usageRecord(value any) map[string]any {
	if value == nil {
		return nil
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

// usageArray returns the value as a list, or an empty list.
func usageArray(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return []any{}
}

// usageText returns a trimmed non-empty string, or nil.
func usageText(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// number reads a finite number from a JSON value.
func number(value any) *float64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		return &typed
	case float32:
		converted := float64(typed)
		return &converted
	case int:
		converted := float64(typed)
		return &converted
	case int64:
		converted := float64(typed)
		return &converted
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		return &parsed
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		return &parsed
	}
	return nil
}

// usageNumberValue reads a number for an ordered detail table: a missing
// value stays null.
func usageNumberValue(value any) any {
	parsed := number(value)
	if parsed == nil {
		return nil
	}
	return *parsed
}

// boolean reads a boolean from a JSON value.
func boolean(value any) *bool {
	switch typed := value.(type) {
	case bool:
		return &typed
	case string:
		if typed == "true" {
			truth := true
			return &truth
		}
		if typed == "false" {
			falsy := false
			return &falsy
		}
	}
	return nil
}

// clampPercent keeps a percentage inside 0..100.
func clampPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

// parseDate reads an epoch (seconds or milliseconds) or an ISO timestamp.
func parseDate(value any) *int64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		return parseEpoch(typed)
	case int64:
		return parseEpoch(float64(typed))
	case int:
		return parseEpoch(float64(typed))
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return nil
		}
		return parseEpoch(parsed)
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05", "2006-01-02"} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				millis := parsed.UnixMilli()
				return &millis
			}
		}
	}
	return nil
}

// parseEpoch turns a numeric epoch into milliseconds.
func parseEpoch(value float64) *int64 {
	if value <= 0 {
		return nil
	}
	if value < 10_000_000_000 {
		millis := int64(value * 1000)
		return &millis
	}
	millis := int64(value)
	return &millis
}
