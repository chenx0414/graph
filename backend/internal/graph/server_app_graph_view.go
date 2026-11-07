package graph

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

func (app *GraphApp) serveGraph(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskId")
	view := app.runtime.User().Task(taskID).View()
	native := app.appKernelGraph(taskID)
	if native == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"nodes": []appGraphNode{}, "containers": []appGraphContainer{}, "loops": []any{},
			"revisions": []any{}, "layout": appEmptyLayout(), "cost": view["cost"],
			"interfaces": []any{}, "modules": []any{}, "messages": []any{},
		})
		return
	}
	structure := app.appNativeGraphStructure(native.Definition, native)
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": structure.Nodes, "containers": structure.Containers, "loops": structure.Loops,
		"layout": structure.Layout, "cost": view["cost"],
		"revisions":  []any{map[string]any{"version": native.Revision, "reason": "graph definition"}},
		"interfaces": native.Edges, "modules": native.Modules,
		"messages": app.runtime.GraphMessages(taskID),
	})
}

type appKernelGraph struct {
	GraphID      string                `json:"graphId"`
	Definition   GraphDefinition       `json:"definition"`
	Revision     int                   `json:"revision"`
	Edges        []EdgeExplanation     `json:"edges"`
	Modules      []any                 `json:"modules"`
	Nodes        any                   `json:"nodes"`
	States       []appGraphStateNode   `json:"-"`
	StateModules []appGraphStateModule `json:"-"`
}

type appGraphStateNode struct {
	NodeID string `json:"nodeId"`
	Status string `json:"status"`
}

type appGraphStateModule struct {
	ModuleID  string `json:"moduleId"`
	Triggered bool   `json:"triggered"`
}

func (app *GraphApp) appKernelGraph(taskID string) *appKernelGraph {
	value := app.runtime.KernelGraph(taskID)
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	graph := &appKernelGraph{}
	if err := json.Unmarshal(raw, graph); err != nil {
		panic(err)
	}
	state := struct {
		Nodes   []appGraphStateNode   `json:"nodes"`
		Modules []appGraphStateModule `json:"modules"`
	}{}
	if err := json.Unmarshal(raw, &state); err != nil {
		panic(err)
	}
	graph.States = state.Nodes
	graph.StateModules = state.Modules
	return graph
}

type appGraphNode struct {
	ID                string                 `json:"id"`
	Kind              string                 `json:"kind"`
	Action            string                 `json:"action"`
	Container         string                 `json:"container,omitempty"`
	Status            string                 `json:"status"`
	BoundDefinition   string                 `json:"boundDefinition,omitempty"`
	DefinitionVersion string                 `json:"definitionVersion,omitempty"`
	Inputs            map[string]ProtocolRef `json:"inputs"`
	Outputs           map[string]ProtocolRef `json:"outputs"`
	Agent             any                    `json:"agent"`
	Label             string                 `json:"label"`
	VisualKind        string                 `json:"visualKind"`
}

func appGraphNodePicture(id, kind, action string) (string, string) {
	node := GraphNodeLike{Id: id, Kind: kind, Action: action}
	return GraphNodeLabel(node), string(GraphNodeVisualKind(node))
}

type appGraphContainer struct {
	ID       string                 `json:"id"`
	Parent   string                 `json:"parent,omitempty"`
	Template string                 `json:"template"`
	Version  int                    `json:"version"`
	Inputs   map[string]GraphIo     `json:"inputs"`
	Outputs  map[string]GraphOutput `json:"outputs"`
	Nodes    []string               `json:"nodes"`
}

type appGraphStructure struct {
	Nodes      []appGraphNode      `json:"nodes"`
	Containers []appGraphContainer `json:"containers"`
	Loops      []any               `json:"loops"`
	Layout     GraphLayout         `json:"layout"`
}

func appSortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (app *GraphApp) appNativeGraphStructure(definition GraphDefinition, native *appKernelGraph) appGraphStructure {
	groups := appSortedKeys(definition.SubgraphInstances)
	containerFor := func(id string) string {
		best := ""
		for _, group := range groups {
			if strings.HasPrefix(id, group+"/") && len(group) > len(best) {
				best = group
			}
		}
		return best
	}
	containers := []appGraphContainer{}
	for _, id := range groups {
		binding := definition.SubgraphInstances[id]
		container := appGraphContainer{
			ID: id, Parent: containerFor(id), Template: binding.Template, Version: binding.Version,
			Inputs: binding.Inputs, Outputs: binding.Outputs, Nodes: []string{},
		}
		for _, node := range appSortedKeys(definition.Nodes) {
			if strings.HasPrefix(node, id+"/") {
				container.Nodes = append(container.Nodes, node)
			}
		}
		containers = append(containers, container)
	}
	nodes := []appGraphNode{}
	for _, id := range appSortedKeys(definition.Nodes) {
		node := definition.Nodes[id]
		label, visualKind := appGraphNodePicture(id, "agent", node.Task)
		entry := appGraphNode{
			ID: id, Kind: "agent", Action: node.Task, Container: containerFor(id),
			Status: "draft", BoundDefinition: node.Recipe, DefinitionVersion: node.Recipe,
			Inputs: node.Inputs, Outputs: node.Outputs,
			Agent: app.appGraphAgentDetail(node.Recipe), Label: label, VisualKind: visualKind,
		}
		if native != nil {
			entry.Status = "idle"
			for _, state := range native.States {
				if state.NodeID == id {
					entry.Status = state.Status
					break
				}
			}
			if entry.Status == "" {
				entry.Status = "idle"
			}
		}
		nodes = append(nodes, entry)
	}
	for _, id := range appSortedKeys(definition.Modules) {
		module := definition.Modules[id]
		action := "route"
		switch {
		case module.Type == "operation":
			action = "graph.command"
		case module.Type == "command":
			action = "command"
		case module.Trigger == "once":
			action = "join"
		}
		label, visualKind := appGraphNodePicture(id, "module", action)
		entry := appGraphNode{
			ID: id, Kind: "module", Action: action, Container: containerFor(id),
			Status: "draft", Inputs: module.Inputs, Outputs: module.Outputs,
			Label: label, VisualKind: visualKind,
		}
		if native != nil {
			entry.Status = "idle"
			for _, state := range native.StateModules {
				if state.ModuleID == id {
					if state.Triggered {
						entry.Status = "succeeded"
					}
					break
				}
			}
		}
		nodes = append(nodes, entry)
	}
	edges := []appGraphEdge{}
	for _, id := range appSortedKeys(definition.Edges) {
		edge := definition.Edges[id]
		edges = append(edges, appGraphEdge{
			ID:     id,
			Source: strings.SplitN(edge.From, ".", 2)[0],
			Target: strings.SplitN(edge.To, ".", 2)[0],
		})
	}
	input := LayoutInput{Nodes: []LayoutNode{}, Edges: []LayoutEdge{}, Containers: []LayoutGroup{}}
	for _, node := range nodes {
		action := node.Action
		if node.Kind == "agent" {
			action = "work"
		}
		input.Nodes = append(input.Nodes, LayoutNode{ID: node.ID, Kind: node.Kind, Action: action, Container: node.Container})
	}
	for _, edge := range edges {
		input.Edges = append(input.Edges, LayoutEdge{ID: edge.ID, Source: edge.Source, Target: edge.Target})
	}
	for _, container := range containers {
		input.Containers = append(input.Containers, LayoutGroup{ID: container.ID, Parent: container.Parent})
	}
	layout := app.appGraphLayout(input, native)
	return appGraphStructure{Nodes: nodes, Containers: containers, Loops: []any{}, Layout: layout}
}

type appGraphEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

func (app *GraphApp) appGraphLayout(input LayoutInput, native *appKernelGraph) GraphLayout {
	key := CanonicalJSON(input)
	if native == nil {
		return app.appFreshLayout(input, key)
	}
	for {
		state := app.runtime.GraphLayout(native.GraphID, native.Revision)
		epoch := int64(0)
		switch value := state["epoch"].(type) {
		case int64:
			epoch = value
		case int:
			epoch = int64(value)
		case float64:
			epoch = int64(value)
		}
		snapshot, _ := state["snapshot"].(map[string]any)
		if snapshot != nil {
			topology, _ := snapshot["topology"].(string)
			if topology == key {
				return app.appLayoutOf(snapshot["layout"])
			}
			previous := LayoutPrevious{Input: input, Layout: app.appLayoutOf(snapshot["layout"])}
			if stored, err := app.appLayoutInput(topology); err == nil {
				previous.Input = stored
			}
			result := LayoutGraph(input, &previous)
			if app.runtime.SaveGraphLayout(native.GraphID, native.Revision, key, result, epoch) {
				return result
			}
			continue
		}
		result := app.appFreshLayout(input, key)
		if app.runtime.SaveGraphLayout(native.GraphID, native.Revision, key, result, epoch) {
			return result
		}
	}
}

func (app *GraphApp) appFreshLayout(input LayoutInput, key string) GraphLayout {
	app.layoutMutex.Lock()
	defer app.layoutMutex.Unlock()
	if layout, ok := app.layouts[key]; ok {
		return layout
	}
	layout := LayoutGraph(input, nil)
	if len(app.layouts) >= 100 && len(app.layoutOrder) > 0 {
		delete(app.layouts, app.layoutOrder[0])
		app.layoutOrder = app.layoutOrder[1:]
	}
	app.layouts[key] = layout
	app.layoutOrder = append(app.layoutOrder, key)
	return layout
}

func (app *GraphApp) appLayoutOf(value any) GraphLayout {
	if value == nil {
		return appEmptyLayout()
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	layout := GraphLayout{}
	if err := json.Unmarshal(raw, &layout); err != nil {
		panic(err)
	}
	if layout.Positions == nil {
		layout.Positions = map[string]LayoutPosition{}
	}
	if layout.Edges == nil {
		layout.Edges = []LayoutRoutedEdge{}
	}
	return layout
}

func (app *GraphApp) appLayoutInput(topology string) (LayoutInput, error) {
	input := LayoutInput{}
	if err := json.Unmarshal([]byte(topology), &input); err != nil {
		return LayoutInput{}, err
	}
	return input, nil
}
