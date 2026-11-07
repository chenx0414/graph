package graph

import "sync"

type laneTable[T any] struct {
	mutex  sync.Mutex
	values map[string]T
}

func (table *laneTable[T]) Lookup(key string) (T, bool) {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	value, ok := table.values[key]
	return value, ok
}

func (table *laneTable[T]) Get(key string) T {
	value, _ := table.Lookup(key)
	return value
}

func (table *laneTable[T]) Store(key string, value T) {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	if table.values == nil {
		table.values = map[string]T{}
	}
	table.values[key] = value
}

func (table *laneTable[T]) Delete(key string) {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	delete(table.values, key)
}

func (table *laneTable[T]) Keys() []string {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	keys := make([]string, 0, len(table.values))
	for key := range table.values {
		keys = append(keys, key)
	}
	return keys
}

func (table *laneTable[T]) Clear() {
	table.mutex.Lock()
	defer table.mutex.Unlock()
	table.values = nil
}
