package graph

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
