package graph

import (
	"encoding/json"
	"strconv"
	"strings"
)

func agentToolsOptionalString(params map[string]any, key string) *string {
	raw, ok := params[key].(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func agentToolsTrimmedString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func agentToolsBoundedNumber(value any, fallback int) int {
	number, ok := agentToolsNumber(value)
	if !ok {
		return fallback
	}
	if number < 0 {
		return 0
	}
	return int(number)
}

func agentToolsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != typed {
			return 0, false
		}
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return number, true
	}
	return 0, false
}

func agentToolsNumberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, true
		}
		number, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, false
		}
		return number, true
	}
	return agentToolsNumber(value)
}

func agentToolsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && typed == typed
	case float32:
		return typed != 0
	case int:
		return typed != 0
	case int64:
		return typed != 0
	}
	return true
}

func agentToolsStringOrEmpty(value any) string {
	if value == nil {
		return ""
	}
	return agentToolsString(value)
}

func agentToolsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "undefined"
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case int:
		return itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case json.Number:
		return typed.String()
	}
	return stringifyJSON(value)
}

func agentToolsUnique(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func agentToolsContains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func agentToolsTruncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
