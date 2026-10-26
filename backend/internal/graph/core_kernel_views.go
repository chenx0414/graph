package graph

import (
	"sort"
)

// NodeEntryQuery pages one node's transcript.
func KernelHasActiveWork(kernel *KernelStore, graphID string) bool {
	row := kernelRow(kernel.DB, `SELECT 1 WHERE
    EXISTS(SELECT 1 FROM kernel_executions WHERE task_id=? AND state='running') OR
    EXISTS(SELECT 1 FROM kernel_module_operations WHERE task_id=? AND worker_active=1)`, graphID, graphID)
	return row != nil
}

// KernelGraphView is the newest revision plus one-delivery edge and module cards.
func KernelGraphView(kernel *KernelStore, graphID string) any {
	revision := kernel.LatestRevision(graphID)
	if revision == nil {
		return nil
	}
	definition := revision.Definition
	edgeIDs := sortedKeys(definition.Edges)
	edges := []EdgeExplanation{}
	for _, id := range edgeIDs {
		edges = append(edges, ExplainEdge(kernel, graphID, id, nil, EdgeHistoryQuery{Limit: 1}))
	}
	moduleIDs := make([]string, 0, len(definition.Modules))
	for id := range definition.Modules {
		moduleIDs = append(moduleIDs, id)
	}
	sort.Strings(moduleIDs)
	modules := []any{}
	for _, id := range moduleIDs {
		explained := ExplainModule(kernel, graphID, id, ModuleHistoryQuery{IncludeTransitions: boolPtr(false)})
		modules = append(modules, struct {
			ModuleExplanation
			Definition ModuleDefinition `json:"definition"`
		}{explained, definition.Modules[id]})
	}
	return struct {
		GraphID    string            `json:"graphId"`
		Definition GraphDefinition   `json:"definition"`
		Revision   int               `json:"revision"`
		Edges      []EdgeExplanation `json:"edges"`
		Modules    []any             `json:"modules"`
		Nodes      any               `json:"nodes"`
	}{graphID, definition, revision.Version, edges, modules, kernel.ListNodes(graphID)}
}

func boolPtr(value bool) *bool { return &value }

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	// TODO(port): TypeScript Object.keys keeps insertion order.
	sort.Strings(keys)
	return keys
}
