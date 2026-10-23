package graph

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ParseGraphDefinition accepts one whole v2 definition. Any defect refuses the whole definition.
// TODO(port): Go map iteration is not JSON insertion order, so the first reported defect can differ when several keys are wrong.
func ParseGraphDefinition(input any, depth ...int) GraphDefinition {
	level := 0
	if len(depth) > 0 {
		level = depth[0]
	}
	if level > 32 {
		interfaceSpecInvalid("Subgraph expansion exceeds 32 levels or contains recursive definitions")
	}
	raw := interfaceSpecAsMap(input)
	if !interfaceSpecVersionIs(raw["schemaVersion"], INTERFACE_SCHEMA_VERSION) {
		interfaceSpecInvalid(fmt.Sprintf("schemaVersion must be %d; JSON is the only formal format", INTERFACE_SCHEMA_VERSION))
	}
	name, _ := raw["name"].(string)
	if strings.TrimSpace(name) == "" {
		interfaceSpecInvalid("Definition requires a name")
	}
	for _, key := range []string{"protocols", "nodes", "modules", "edges", "inputs", "outputs"} {
		if raw[key] == nil {
			raw[key] = map[string]any{}
		}
		if _, ok := raw[key].(map[string]any); !ok {
			interfaceSpecInvalid("protocols, nodes, modules, edges, inputs and outputs must be maps")
		}
	}
	for _, pair := range []struct {
		key, what string
	}{{"protocols", "Protocol"}, {"nodes", "Node"}, {"modules", "Module"}, {"edges", "Edge"}} {
		record := raw[pair.key].(map[string]any)
		for key := range record {
			if strings.TrimSpace(key) == "" {
				interfaceSpecInvalid(pair.what + " id must not be blank")
			}
		}
	}
	if defaults, ok := raw["defaults"]; ok && defaults != nil {
		record, ok := defaults.(map[string]any)
		if !ok {
			interfaceSpecInvalid("Graph defaults must contain model, retry or budget settings")
		}
		for key := range record {
			if key != "model" && key != "retry" && key != "budget" {
				interfaceSpecInvalid("Graph defaults must contain model, retry or budget settings")
			}
		}
		interfaceSpecValidateSettings("Graph defaults", record)
	}
	definition := map[string]any{
		"schemaVersion": float64(INTERFACE_SCHEMA_VERSION),
		"name":          raw["name"],
		"protocols":     raw["protocols"],
		"nodes":         raw["nodes"],
		"modules":       raw["modules"],
		"edges":         raw["edges"],
		"inputs":        raw["inputs"],
		"outputs":       raw["outputs"],
	}
	if raw["defaults"] != nil {
		definition["defaults"] = raw["defaults"]
	}
	if raw["acceptance"] != nil {
		definition["acceptance"] = jsonClone(raw["acceptance"])
	}
	if completion, ok := raw["completion"].(map[string]any); ok {
		definition["completion"] = completion
	}
	if subgraphs, ok := raw["subgraphs"].([]any); ok {
		definition["subgraphs"] = subgraphs
	}
	if instances, ok := raw["subgraphInstances"].(map[string]any); ok {
		definition["subgraphInstances"] = instances
	}
	if raw["instances"] != nil {
		instances, instancesOK := raw["instances"].(map[string]any)
		templates, templatesOK := raw["templates"].(map[string]any)
		if !instancesOK || !templatesOK {
			interfaceSpecInvalid("Subgraph instances and templates must be maps")
		}
		definition["nodes"] = interfaceSpecCloneMap(definition["nodes"].(map[string]any))
		definition["modules"] = interfaceSpecCloneMap(definition["modules"].(map[string]any))
		definition["edges"] = interfaceSpecCloneMap(definition["edges"].(map[string]any))
		definition["protocols"] = interfaceSpecCloneMap(definition["protocols"].(map[string]any))
		definition["inputs"] = interfaceSpecCloneMap(definition["inputs"].(map[string]any))
		definition["outputs"] = interfaceSpecCloneMap(definition["outputs"].(map[string]any))
		if definition["subgraphInstances"] == nil {
			definition["subgraphInstances"] = map[string]any{}
		} else {
			definition["subgraphInstances"] = interfaceSpecCloneMap(definition["subgraphInstances"].(map[string]any))
		}
		for id, value := range instances {
			nodes := definition["nodes"].(map[string]any)
			modules := definition["modules"].(map[string]any)
			if id == "" || strings.ContainsAny(id, "./") || nodes[id] != nil || modules[id] != nil {
				interfaceSpecInvalid("Invalid or conflicting subgraph instance " + id)
			}
			record, ok := value.(map[string]any)
			templateName, _ := record["template"].(string)
			if !ok || templateName == "" || !isSafeInteger(record["version"]) || asFloatMust(record["version"]) < 1 {
				interfaceSpecInvalid("Subgraph " + id + " must pin a template and positive version")
			}
			declaration, _ := templates[templateName].(map[string]any)
			if declaration == nil || !interfaceSpecVersionIs(declaration["version"], asFloatMust(record["version"])) {
				interfaceSpecInvalid("Subgraph " + id + " template version is unavailable")
			}
			template := ParseGraphDefinition(declaration["definition"], level+1)
			expanded := ExpandSubgraph(ExpandInput{Instance: id, Template: template, TemplateVersion: int(asFloatMust(record["version"]))})
			protocols := definition["protocols"].(map[string]any)
			for name, protocol := range template.Protocols {
				if existing, ok := protocols[name]; ok && jsonStringify(existing) != jsonStringify(protocol) {
					interfaceSpecInvalid("Subgraph " + id + " conflicts with protocol " + name)
				}
				protocols[name] = protocol
			}
			for name, node := range expanded.Nodes {
				if nodes[name] != nil || modules[name] != nil {
					interfaceSpecInvalid("Duplicate expanded node " + name)
				}
				nodes[name] = node
			}
			for name, module := range expanded.Modules {
				if nodes[name] != nil || modules[name] != nil {
					interfaceSpecInvalid("Duplicate expanded module " + name)
				}
				modules[name] = module
			}
			edges := definition["edges"].(map[string]any)
			for name, edge := range expanded.Edges {
				key := id + "/" + name
				if edges[key] != nil {
					interfaceSpecInvalid("Duplicate expanded edge " + key)
				}
				edges[key] = edge
			}
			bindings := definition["subgraphInstances"].(map[string]any)
			bindings[id] = map[string]any{"template": templateName, "version": record["version"], "inputs": expanded.Inputs, "outputs": expanded.Outputs}
			for nestedID, nested := range template.SubgraphInstances {
				inputs := map[string]any{}
				for port, io := range nested.Inputs {
					io.To = id + "/" + io.To
					inputs[port] = io
				}
				outputs := map[string]any{}
				for port, io := range nested.Outputs {
					io.From = id + "/" + io.From
					outputs[port] = io
				}
				bindings[id+"/"+nestedID] = map[string]any{"template": nested.Template, "version": nested.Version, "inputs": inputs, "outputs": outputs}
			}
		}
		resolve := func(reference, kind string) string {
			dot := strings.Index(reference, ".")
			if dot < 0 {
				return reference
			}
			bindings := definition["subgraphInstances"].(map[string]any)
			instance, _ := bindings[reference[:dot]].(map[string]any)
			if instance == nil {
				if typed, ok := bindings[reference[:dot]].(SubgraphInstanceBinding); ok {
					port := reference[dot+1:]
					if kind == "input" {
						mapped, ok := typed.Inputs[port]
						if !ok {
							interfaceSpecInvalid("Unknown subgraph " + kind + " " + reference)
						}
						return mapped.To
					}
					mapped, ok := typed.Outputs[port]
					if !ok {
						interfaceSpecInvalid("Unknown subgraph " + kind + " " + reference)
					}
					return mapped.From
				}
				return reference
			}
			port := reference[dot+1:]
			side := "outputs"
			field := "from"
			if kind == "input" {
				side = "inputs"
				field = "to"
			}
			ports, _ := instance[side].(map[string]any)
			mapped, _ := ports[port].(map[string]any)
			if mapped == nil {
				interfaceSpecInvalid("Unknown subgraph " + kind + " " + reference)
			}
			text, _ := mapped[field].(string)
			return text
		}
		edges := definition["edges"].(map[string]any)
		for name, value := range edges {
			edge, ok := value.(map[string]any)
			if !ok {
				if typed, ok := value.(EdgeDefinition); ok {
					typed.From = resolve(typed.From, "output")
					typed.To = resolve(typed.To, "input")
					edges[name] = typed
				}
				continue
			}
			from, _ := edge["from"].(string)
			to, _ := edge["to"].(string)
			edge["from"] = resolve(from, "output")
			edge["to"] = resolve(to, "input")
		}
		for _, io := range definition["inputs"].(map[string]any) {
			record, ok := io.(map[string]any)
			if !ok {
				continue
			}
			target, _ := record["to"].(string)
			record["to"] = resolve(target, "input")
		}
		for _, io := range definition["outputs"].(map[string]any) {
			record, ok := io.(map[string]any)
			if !ok {
				continue
			}
			target, _ := record["from"].(string)
			record["from"] = resolve(target, "output")
		}
		keys := []string{}
		for key := range definition["subgraphInstances"].(map[string]any) {
			keys = append(keys, key)
		}
		definition["subgraphs"] = keys
	}
	if definition["acceptance"] != nil {
		items, ok := definition["acceptance"].([]any)
		if !ok || len(items) > 100 {
			interfaceSpecInvalid("Graph acceptance must be a list of at most 100 criteria")
		}
		ids := map[string]bool{}
		modules := definition["modules"].(map[string]any)
		nodes := definition["nodes"].(map[string]any)
		for _, item := range items {
			record, ok := item.(map[string]any)
			id, _ := record["id"].(string)
			description, _ := record["description"].(string)
			if !ok || strings.TrimSpace(id) == "" || ids[id] || strings.TrimSpace(description) == "" {
				interfaceSpecInvalid("Acceptance criteria require unique ids and descriptions")
			}
			ids[id] = true
			kind, _ := record["kind"].(string)
			allowed := []string{"id", "description", "kind"}
			if kind == "check" {
				moduleName, _ := record["module"].(string)
				module, _ := modules[moduleName].(map[string]any)
				if module == nil || module["type"] != "operation" {
					interfaceSpecInvalid("Acceptance " + id + " must name a host operation module")
				}
				allowed = append(allowed, "module")
			} else if kind == "review" {
				nodeName, _ := record["node"].(string)
				node, _ := nodes[nodeName].(map[string]any)
				recipe, _ := node["recipe"].(string)
				if strings.TrimSpace(recipe) == "" {
					interfaceSpecInvalid("Acceptance " + id + " must name an agent reviewer")
				}
				allowed = append(allowed, "node")
			} else if kind != "human" {
				interfaceSpecInvalid("Acceptance has unknown kind")
			}
			for key := range record {
				if !interfaceSpecContains(allowed, key) {
					interfaceSpecInvalid("Acceptance " + id + " has unknown fields")
				}
			}
		}
	}
	protocols := definition["protocols"].(map[string]any)
	for id, protocol := range protocols {
		func() {
			defer func() {
				recovered := recover()
				if recovered == nil {
					return
				}
				message := panicMessage(recovered)
				if re, ok := recovered.(*RuntimeError); ok {
					message = re.Message
				}
				interfaceSpecInvalid("Protocol " + id + " has an invalid schema: " + message)
			}()
			record, ok := protocol.(map[string]any)
			if !ok {
				record = interfaceSpecAsMap(protocol)
			}
			interfaceSpecCompile(record)
		}()
	}
	nodes := definition["nodes"].(map[string]any)
	for id, node := range nodes {
		record, ok := node.(map[string]any)
		if !ok {
			record = interfaceSpecAsMap(node)
			nodes[id] = record
		}
		interfaceSpecValidateNode(definition, id, record)
	}
	modules := definition["modules"].(map[string]any)
	for id, module := range modules {
		record, ok := module.(map[string]any)
		if !ok {
			record = interfaceSpecAsMap(module)
			modules[id] = record
		}
		interfaceSpecValidateModule(definition, id, record)
	}
	edges := definition["edges"].(map[string]any)
	for id, edgeValue := range edges {
		edge, ok := edgeValue.(map[string]any)
		if !ok {
			edge = interfaceSpecAsMap(edgeValue)
			edges[id] = edge
		}
		enabled, isBool := edge["enabled"].(bool)
		if !isBool || !enabled && edge["enabled"] != false {
			interfaceSpecInvalid("Edge " + id + " enabled must be an explicit boolean")
		}
		if _, isBool := edge["enabled"].(bool); !isBool {
			interfaceSpecInvalid("Edge " + id + " enabled must be an explicit boolean")
		}
		fromText, _ := edge["from"].(string)
		toText, _ := edge["to"].(string)
		from := interfaceSpecEndpointRef(definition, fromText, "output")
		to := interfaceSpecEndpointRef(definition, toText, "input")
		if from == nil {
			interfaceSpecInvalid("Edge " + id + " names unknown output endpoint " + fromText)
		}
		if to == nil {
			interfaceSpecInvalid("Edge " + id + " names unknown input endpoint " + toText)
		}
		interfaceSpecAssertSame(definition, from, to, "Edge "+id)
	}
	for name, io := range definition["inputs"].(map[string]any) {
		record, _ := io.(map[string]any)
		if record == nil {
			record = interfaceSpecAsMap(io)
		}
		target, _ := record["to"].(string)
		ref := interfaceSpecEndpointRef(definition, target, "input")
		if ref == nil {
			interfaceSpecInvalid("Graph input " + name + " names unknown endpoint " + target)
		}
		promised := map[string]any{"protocol": record["protocol"]}
		if record["version"] != nil {
			promised["version"] = record["version"]
		}
		interfaceSpecAssertSame(definition, promised, ref, "Graph input "+name)
	}
	for name, io := range definition["outputs"].(map[string]any) {
		record, _ := io.(map[string]any)
		if record == nil {
			record = interfaceSpecAsMap(io)
		}
		target, _ := record["from"].(string)
		ref := interfaceSpecEndpointRef(definition, target, "output")
		if ref == nil {
			interfaceSpecInvalid("Graph output " + name + " names unknown endpoint " + target)
		}
		promised := map[string]any{"protocol": record["protocol"]}
		if record["version"] != nil {
			promised["version"] = record["version"]
		}
		interfaceSpecAssertSame(definition, ref, promised, "Graph output "+name)
	}
	if completion, ok := definition["completion"].(map[string]any); ok {
		on, _ := completion["on"].(string)
		outputs := definition["outputs"].(map[string]any)
		if _, known := outputs[on]; !known {
			interfaceSpecInvalid("completion.on names undeclared graph output " + on)
		}
	}
	encoded, err := json.Marshal(definition)
	if err != nil {
		panic(err)
	}
	var parsed GraphDefinition
	if err := json.Unmarshal(encoded, &parsed); err != nil {
		panic(err)
	}
	if parsed.Protocols == nil {
		parsed.Protocols = map[string]ProtocolSpec{}
	}
	if parsed.Nodes == nil {
		parsed.Nodes = map[string]NodeDefinition{}
	}
	if parsed.Modules == nil {
		parsed.Modules = map[string]ModuleDefinition{}
	}
	if parsed.Edges == nil {
		parsed.Edges = map[string]EdgeDefinition{}
	}
	if parsed.Inputs == nil {
		parsed.Inputs = map[string]GraphIo{}
	}
	if parsed.Outputs == nil {
		parsed.Outputs = map[string]GraphOutput{}
	}
	return parsed
}
