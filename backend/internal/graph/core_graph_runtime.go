package graph

type GraphPhase string

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

type GraphPatchResult struct {
	Revision int `json:"revision"`
}
