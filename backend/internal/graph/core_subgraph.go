package graph

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ExpandInput pins one subgraph template into a parent fragment.
type ExpandInput struct {
	Instance        string
	Template        GraphDefinition
	TemplateVersion int
	InputWiring     map[string]string
	OutputWiring    map[string]string
}

// ExpandedSubgraph is the rewritten fragment. Expansion adds no execution.
type ExpandedSubgraph struct {
	Instance        string
	TemplateVersion int
	Nodes           map[string]NodeDefinition
	Modules         map[string]ModuleDefinition
	Edges           map[string]EdgeDefinition
	Inputs          map[string]GraphIo
	Outputs         map[string]GraphOutput
	Wiring          struct {
		Inputs  map[string]string
		Outputs map[string]string
	}
}

func subgraphEndpoint(instance, reference string) string {
	dot := strings.Index(reference, ".")
	if dot <= 0 {
		return reference
	}
	return instance + "/" + reference[:dot] + reference[dot:]
}

// ExpandSubgraph rewrites a template into instance-prefixed paths.
func ExpandSubgraph(input ExpandInput) ExpandedSubgraph {
	if strings.TrimSpace(input.Instance) == "" {
		panic(fmt.Errorf("A subgraph instance requires a name"))
	}
	nodes := map[string]NodeDefinition{}
	for id, node := range input.Template.Nodes {
		nodes[input.Instance+"/"+id] = mergeSubgraphNode(input.Template.Defaults, node)
	}
	modules := map[string]ModuleDefinition{}
	for id, module := range input.Template.Modules {
		modules[input.Instance+"/"+id] = cloneJSON(module)
	}
	edges := map[string]EdgeDefinition{}
	for id, edge := range input.Template.Edges {
		edge.From = subgraphEndpoint(input.Instance, edge.From)
		edge.To = subgraphEndpoint(input.Instance, edge.To)
		edges[id] = edge
	}
	inputs := map[string]GraphIo{}
	for name, io := range input.Template.Inputs {
		io.To = subgraphEndpoint(input.Instance, io.To)
		inputs[name] = io
	}
	outputs := map[string]GraphOutput{}
	for name, io := range input.Template.Outputs {
		io.From = subgraphEndpoint(input.Instance, io.From)
		outputs[name] = io
	}
	result := ExpandedSubgraph{
		Instance:        input.Instance,
		TemplateVersion: input.TemplateVersion,
		Nodes:           nodes,
		Modules:         modules,
		Edges:           edges,
		Inputs:          inputs,
		Outputs:         outputs,
	}
	result.Wiring.Inputs = copyStringMap(input.InputWiring)
	result.Wiring.Outputs = copyStringMap(input.OutputWiring)
	return result
}

func copyStringMap(values map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range values {
		out[key] = value
	}
	return out
}

func cloneJSON[T any](value T) T {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}

func mergeSubgraphNode(defaults *ExecutionSettings, node NodeDefinition) NodeDefinition {
	if defaults == nil {
		return cloneJSON(node)
	}
	base := map[string]any{}
	raw, err := json.Marshal(defaults)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		panic(err)
	}
	over := map[string]any{}
	raw, err = json.Marshal(node)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(raw, &over); err != nil {
		panic(err)
	}
	if defaultsRetry, ok := base["retry"].(map[string]any); ok {
		merged := map[string]any{}
		for key, value := range defaultsRetry {
			merged[key] = value
		}
		if nodeRetry, ok := over["retry"].(map[string]any); ok {
			for key, value := range nodeRetry {
				merged[key] = value
			}
		}
		over["retry"] = merged
	}
	for key, value := range over {
		base[key] = value
	}
	raw, err = json.Marshal(base)
	if err != nil {
		panic(err)
	}
	var merged NodeDefinition
	if err := json.Unmarshal(raw, &merged); err != nil {
		panic(err)
	}
	return merged
}
