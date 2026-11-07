package graph

func anySortedKeys(value any) []string {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return sortedKeys(record)
}
