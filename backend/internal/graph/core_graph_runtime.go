package graph

// GraphPhase is one of the eight lifecycle phases.
type GraphPhase string

// GraphStateRow is the lifecycle row the main agent reads.
type GraphStateRow struct {
	GraphId  string     `json:"graphId"`
	Phase    GraphPhase `json:"phase"`
	Revision int        `json:"revision"`
}

// PatchChange is one revision's reason plus a full definition or a merge patch.
type PatchChange struct {
	Reason     string
	Definition *GraphDefinition
	Patch      any
	Retire     []string
	HasPatch   bool
}

// CreatedGraph is the graph create returns.
type CreatedGraph struct {
	GraphId    string          `json:"graphId"`
	Definition GraphDefinition `json:"definition"`
	Revision   struct {
		Version int `json:"version"`
	} `json:"revision"`
}

// GraphRuntime owns graph lifecycle and the main agent's control surface.
type GraphRuntime struct {
	kernel    *KernelStore
	graphId   string
	artifacts *ArtifactWorkspace
}

// GraphPatchResult is what a published patch answers with.
type GraphPatchResult struct {
	Revision int `json:"revision"`
}
