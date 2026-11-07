package graph

import (
	"fmt"
	"reflect"
	"strings"
)

func conversationActivityKey(record ConversationActivityRecord, index int) string {
	if record.Kind == ConversationActivityTool {
		if value, ok := record.Data["toolCallId"]; ok && value != nil {
			return "tool:" + conversationActivityStringify(value)
		}
		if record.Ordinal != nil {
			return "tool:" + itoa(*record.Ordinal)
		}
		return "tool:" + itoa(index)
	}
	if record.Ordinal != nil {
		return "text:" + itoa(*record.Ordinal)
	}
	return "text:" + itoa(index)
}

func conversationActivityItems(activity any) []any {
	if activity == nil {
		return nil
	}
	if items, ok := activity.([]any); ok {
		return items
	}
	value := reflect.ValueOf(activity)
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Slice && value.Kind() != reflect.Array {
		return nil
	}
	items := make([]any, 0, value.Len())
	for index := 0; index < value.Len(); index++ {
		items = append(items, value.Index(index).Interface())
	}
	return items
}

func conversationActivityIsArray(value any) bool {
	if value == nil {
		return false
	}
	if _, ok := value.([]any); ok {
		return true
	}
	reflected := reflect.ValueOf(value)
	return reflected.Kind() == reflect.Slice || reflected.Kind() == reflect.Array
}

func conversationActivityEntry(item any) (map[string]any, bool) {
	if item == nil {
		return nil, false
	}
	if record, ok := item.(map[string]any); ok {
		return record, true
	}
	value := reflect.ValueOf(item)
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil, false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return nil, false
	}
	record := map[string]any{}
	structType := value.Type()
	for index := 0; index < structType.NumField(); index++ {
		field := structType.Field(index)
		if field.PkgPath != "" {
			continue
		}
		name := field.Name
		if tag, ok := field.Tag.Lookup("json"); ok {
			tagName := strings.Split(tag, ",")[0]
			if tagName == "-" {
				continue
			}
			if tagName != "" {
				name = tagName
			}
		}
		record[name] = value.Field(index).Interface()
	}
	return record, true
}

func conversationActivityOrdinal(value any) *int {
	switch typed := value.(type) {
	case int:
		ordinal := typed
		return &ordinal
	case int64:
		ordinal := int(typed)
		return &ordinal
	case float64:
		ordinal := int(typed)
		return &ordinal
	default:
		return nil
	}
}

func conversationActivityString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func conversationActivityStringify(value any) string {
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
	case int:
		return itoa(typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case float64:
		return strings.TrimSuffix(fmt.Sprintf("%v", typed), ".0")
	default:
		return fmt.Sprintf("%v", typed)
	}
}
