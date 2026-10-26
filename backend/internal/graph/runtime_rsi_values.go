package graph

import (
	"reflect"
	"unicode"
)

// rsiAsArray returns the array behind a value, or an empty array.
func rsiAsArray(value any) []any {
	items, ok := rsiAsArrayOf(value)
	if !ok {
		return []any{}
	}
	return items
}

// rsiAsArrayOf returns the array behind a value and whether it was one.
func rsiAsArrayOf(value any) ([]any, bool) {
	if value == nil {
		return nil, false
	}
	reflected := reflect.ValueOf(value)
	if reflected.Kind() != reflect.Slice && reflected.Kind() != reflect.Array {
		return nil, false
	}
	out := make([]any, reflected.Len())
	for index := 0; index < reflected.Len(); index++ {
		out[index] = reflected.Index(index).Interface()
	}
	return out, true
}

// rsiIsArray reports whether a value is an array, the way Array.isArray does.
func rsiIsArray(value any) bool {
	if value == nil {
		return false
	}
	reflected := reflect.ValueOf(value)
	return reflected.Kind() == reflect.Slice || reflected.Kind() == reflect.Array
}

// rsiPlainObject returns the object behind a value. Arrays and scalars are not a shape mistake.
func rsiPlainObject(value any) map[string]any {
	if value == nil {
		return nil
	}
	reflected := reflect.ValueOf(value)
	if reflected.Kind() != reflect.Map || reflected.Type().Key().Kind() != reflect.String {
		return nil
	}
	out := map[string]any{}
	for _, key := range reflected.MapKeys() {
		out[key.String()] = reflected.MapIndex(key).Interface()
	}
	return out
}

// rsiHasOwn reports whether an object carries a key.
func rsiHasOwn(object map[string]any, key string) bool {
	_, ok := object[key]
	return ok
}

// rsiText reads a string field, or the empty string.
func rsiText(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}

// rsiHasWhitespace reports whether a string carries whitespace.
func rsiHasWhitespace(value string) bool {
	for _, symbol := range value {
		if unicode.IsSpace(symbol) {
			return true
		}
	}
	return false
}
