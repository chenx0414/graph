package graph

type GraphStateRow struct {
	GraphId  string     `json:"graphId"`
	Phase    GraphPhase `json:"phase"`
	Revision int        `json:"revision"`
}

type PatchChange struct {
	Reason     string
	Definition *GraphDefinition
	Patch      any
	Retire     []string
	HasPatch   bool
}

type CreatedGraph struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   struct {
		Version int `json:"version"`
	} `json:"revision"`
}

type GraphRuntime struct {
	kernel    *KernelStore
	graphId   string
	artifacts *ArtifactWorkspace
}

func (runtime *GraphRuntime) scoped(tx *TaskStore) *GraphRuntime {
	scoped := *runtime
	if runtime.kernel != nil {
		scoped.kernel = runtime.kernel.scoped(tx)
	}
	if runtime.artifacts != nil {
		scoped.artifacts = runtime.artifacts.scoped(tx)
	}
	return &scoped
}

type GraphPatchResult struct {
	Revision int `json:"revision"`
}
