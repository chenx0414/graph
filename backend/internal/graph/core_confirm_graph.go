package graph

import (
	"fmt"
)

type MaterializedGraph struct {
	Revision   struct{ Version int }
	Definition GraphDefinition
	NodeIDs    []string
	ModuleIDs  []string
}

func MaterializeGraph(kernel *KernelStore, taskID string, definition GraphDefinition, reason string) MaterializedGraph {
	if kernel.LatestRevision(taskID) != nil {
		panic(fmt.Errorf("task %s already has a v2 graph; materialising it again would duplicate its rows", taskID))
	}
	revision := kernel.InsertRevision(taskID, ParseGraphDefinition(definition), reason, 1)
	nodeIDs := sortedKeys(revision.Definition.Nodes)
	moduleIDs := sortedKeys(revision.Definition.Modules)
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
