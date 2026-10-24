package graph

import (
	"encoding/json"
)

// NewGraphRuntime binds one graph id to the shared kernel.
func NewGraphRuntime(kernel *KernelStore, graphId string, artifacts *ArtifactWorkspace) *GraphRuntime {
	return &GraphRuntime{kernel: kernel, graphId: graphId, artifacts: artifacts}
}

func (runtime *GraphRuntime) taskRow() map[string]any {
	return kernelRow(runtime.kernel.DB, "SELECT id FROM tasks WHERE id=?", runtime.graphId)
}

func (runtime *GraphRuntime) ensureTask() {
	if runtime.taskRow() == nil {
		Raise("invalid_graph", "Graph "+runtime.graphId+" does not exist; call create first")
	}
}

// Create validates the whole definition and produces the first revision.
func (runtime *GraphRuntime) Create(definition any, request, projectId string) CreatedGraph {
	parsed := ParseGraphDefinition(definition)
	if projectId == "" {
		projectId = "p1"
	}
	if request == "" {
		request = parsed.Name
	}
	created := runtime.kernel.Store.Transaction(func() any {
		if runtime.taskRow() != nil {
			Raise("invalid_graph", "Graph "+runtime.graphId+" already exists")
		}
		runtime.kernel.Store.CreateGraphTask(runtime.graphId, projectId, request, NowMillis())
		revision := runtime.kernel.InsertRevision(runtime.graphId, parsed, "create")
		result := CreatedGraph{GraphId: runtime.graphId, Definition: parsed}
		result.Revision.Version = revision.Version
		return result
	}).(CreatedGraph)
	return created
}

// Patch publishes a new revision. A stale base changes nothing.
func (runtime *GraphRuntime) Patch(baseRevision int, changes PatchChange) struct{ Revision int } {
	runtime.ensureTask()
	phase := runtime.State().Phase
	if phase == "completed" || phase == "stopping" || phase == "stopped" {
		Raise("invalid_graph", "Ended graph cannot be patched")
	}
	latest := runtime.kernel.LatestRevision(runtime.graphId)
	if latest == nil {
		Raise("invalid_graph", "Graph "+runtime.graphId+" has no revision to patch")
	}
	if latest.Version != baseRevision {
		Raise("stale_revision", "Patch is based on revision "+itoa(baseRevision)+" but the current revision is "+itoa(latest.Version))
	}
	if stringsTrim(changes.Reason) == "" {
		Raise("invalid_input", "Graph change requires a reason")
	}
	if (changes.Definition != nil) == changes.HasPatch {
		Raise("invalid_input", "Supply exactly one full definition or local patch")
	}
	var parsed GraphDefinition
	if !changes.HasPatch {
		parsed = ParseGraphDefinition(*changes.Definition)
	} else {
		parsed = ParseGraphDefinition(patchedDefinition(latest.Definition, changes.Patch))
	}
	if len(latest.Definition.Acceptance) > 0 && CanonicalJSON(parsed.Acceptance) != CanonicalJSON(latest.Definition.Acceptance) {
		Raise("invalid_input", "Patch cannot change declared final acceptance")
	}
	for _, criterion := range latest.Definition.Acceptance {
		if criterion.Kind == "check" && CanonicalJSON(parsed.Modules[criterion.Module].Operation) != CanonicalJSON(latest.Definition.Modules[criterion.Module].Operation) {
			Raise("invalid_input", "Patch cannot change declared acceptance check "+criterion.Module)
		}
	}
	for _, id := range changes.Retire {
		_, node := latest.Definition.Nodes[id]
		_, module := latest.Definition.Modules[id]
		if !node && !module {
			Raise("invalid_graph", "Retire names unknown node or module "+id)
		}
	}
	return runtime.kernel.Store.Transaction(func() any {
		var removed []string
		for id := range latest.Definition.Nodes {
			if _, ok := parsed.Nodes[id]; !ok {
				if _, ok := parsed.Modules[id]; !ok {
					removed = append(removed, id)
				}
			}
		}
		for id := range latest.Definition.Modules {
			if _, ok := parsed.Nodes[id]; ok {
				continue
			}
			if _, ok := parsed.Modules[id]; ok {
				continue
			}
			removed = append(removed, id)
		}
		for _, id := range removed {
			if !containsString(changes.Retire, id) {
				Raise("invalid_graph", "Removing "+id+" requires explicit retire")
			}
			pending := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state IN ('queued','claimed','failed') LIMIT 1", runtime.graphId, id)
			inbox := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND module_id=? AND processed=0 LIMIT 1", runtime.graphId, id)
			running := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1", runtime.graphId, id)
			outbox := kernelRow(runtime.kernel.DB, "SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND t.module_id=? AND o.routed=0 LIMIT 1", runtime.graphId, id)
			if pending != nil || inbox != nil || running != nil || outbox != nil {
				Raise("pending_work", "Cannot remove "+id+": settle or explicitly cancel its pending work first")
			}
		}
		revision := runtime.kernel.InsertRevision(runtime.graphId, parsed, changes.Reason)
		for id, node := range parsed.Nodes {
			if _, ok := latest.Definition.Nodes[id]; !ok {
				runtime.kernel.AdmitNode(runtime.graphId, revision.Version, id, AdmitNodeInput{InstanceId: graphUUID()})
			} else {
				encoded, err := json.Marshal(node)
				if err != nil {
					panic(err)
				}
				runtime.kernel.ApplyNodeRevision(runtime.graphId, id, revision.Version, string(encoded))
			}
		}
		for id, module := range parsed.Modules {
			if _, ok := latest.Definition.Modules[id]; !ok {
				runtime.kernel.AdmitModule(runtime.graphId, revision.Version, id, AdmitModuleInput{ModuleType: module.Type, Trigger: module.Trigger})
			} else {
				runtime.kernel.ApplyModuleRevision(runtime.graphId, id, revision.Version, module.Type, module.Trigger)
			}
		}
		for _, id := range removed {
			nodeId := id
			FinishNativePauses(runtime.kernel.Store, runtime.graphId, &nodeId)
		}
		for _, id := range removed {
			runtime.kernel.RetireNode(runtime.graphId, id)
		}
		runtime.kernel.Store.Event(runtime.graphId, "graph.patched", map[string]any{"revision": revision.Version, "previousRevision": latest.Version, "reason": changes.Reason})
		return struct{ Revision int }{Revision: revision.Version}
	}).(struct{ Revision int })
}
