package graph

import "sort"

// sortedKeys returns the keys of values in ascending byte order. Go map iteration
// is unordered, so every walk over a definition's maps goes through here: TypeScript
// walks an object in insertion order, and sorting is what keeps the Go walk equal to
// the stored revision the TypeScript side reads back.
func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// anySortedKeys is sortedKeys for a decoded JSON object, which arrives as
// map[string]any. It returns nil when value is not an object, which is how a
// definition spells a map it does not carry.
func anySortedKeys(value any) []string {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return sortedKeys(record)
}
