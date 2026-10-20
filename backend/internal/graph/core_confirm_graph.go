package graph

import (
	"fmt"
	"sort"
)

// MaterializedGraph is the v2 graph created from a confirmed draft.
type MaterializedGraph struct {
	Revision   struct{ Version int }
	Definition GraphDefinition
	NodeIDs    []string
	ModuleIDs  []string
}

// MaterializeGraph admits revision 1 of a v2 graph inside the caller's transaction.
// A second call panics with a plain error, matching the TypeScript refusal.
func MaterializeGraph(kernel *KernelStore, taskID string, definition GraphDefinition, reason string) MaterializedGraph {
	if kernel.LatestRevision(taskID) != nil {
		panic(fmt.Errorf("task %s already has a v2 graph; materialising it again would duplicate its rows", taskID))
	}
	revision := kernel.InsertRevision(taskID, ParseGraphDefinition(definition), reason, 1)
	nodeIDs := mapKeys(revision.Definition.Nodes)
	moduleIDs := mapKeys(revision.Definition.Modules)
	for _, nodeID := range nodeIDs {
		kernel.AdmitNode(taskID, revision.Version, nodeID, AdmitNodeInput{InstanceID: graphUUID()})
	}
	for _, moduleID := range moduleIDs {
		declared := revision.Definition.Modules[moduleID]
		kernel.AdmitModule(taskID, revision.Version, moduleID, AdmitModuleInput{ModuleType: declared.Type, Trigger: declared.Trigger})
	}
	return MaterializedGraph{
		Revision:   struct{ Version int }{Version: revision.Version},
		Definition: revision.Definition,
		NodeIDs:    nodeIDs,
		ModuleIDs:  moduleIDs,
	}
}

func mapKeys[V any](values map[string]V) []string {
	// TODO(port): Go maps have no insertion order. Keys are sorted so admission is stable.
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
