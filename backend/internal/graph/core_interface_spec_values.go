package graph

import (
	"fmt"
	"strings"

	"encoding/json"
)

func interfaceSpecInvalid(reason string) {
	Raise("invalid_definition", reason)
}

func interfaceSpecAsMap(value any) map[string]any {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		interfaceSpecInvalid("Definition must be a JSON object")
	}
	return record
}

func interfaceSpecVersionIs(value any, want float64) bool {
	number, ok := asFloat(value)
	return ok && number == want
}

func interfaceSpecSafeNonNegative(value any) bool {
	return isSafeInteger(value) && asFloatMust(value) >= 0
}

func asFloatMust(value any) float64 {
	number, _ := asFloat(value)
	return number
}

func interfaceSpecSplitEndpoint(endpoint string) (string, string) {
	dot := strings.Index(endpoint, ".")
	if dot <= 0 || dot == len(endpoint)-1 {
		interfaceSpecInvalid("Endpoint " + endpoint + " must be \"<node>.<port>\"")
	}
	return endpoint[:dot], endpoint[dot+1:]
}

func interfaceSpecRefVersion(ref map[string]any) float64 {
	if _, ok := ref["version"]; !ok || ref["version"] == nil {
		return 1
	}
	return asFloatMust(ref["version"])
}

func interfaceSpecProtocolKey(ref map[string]any) string {
	return fmt.Sprintf("%v@%v", ref["protocol"], interfaceSpecRefVersion(ref))
}

func interfaceSpecAssertSame(definition map[string]any, from, to map[string]any, where string) {
	if from == nil {
		interfaceSpecInvalid(where + " names an unknown source endpoint")
	}
	if to == nil {
		interfaceSpecInvalid(where + " names an unknown target endpoint")
	}
	if interfaceSpecProtocolKey(from) != interfaceSpecProtocolKey(to) {
		interfaceSpecInvalid(where + " connects " + interfaceSpecProtocolKey(from) + " to " + interfaceSpecProtocolKey(to) + "; both ends must reference the same protocol id and version")
	}
	protocols, _ := definition["protocols"].(map[string]any)
	name, _ := from["protocol"].(string)
	if _, ok := protocols[name]; !ok {
		interfaceSpecInvalid(where + " references undeclared protocol " + name)
	}
}

func interfaceSpecAssertDeclared(definition map[string]any, ref map[string]any, where string) {
	if ref == nil {
		return
	}
	protocols, _ := definition["protocols"].(map[string]any)
	name, _ := ref["protocol"].(string)
	if _, ok := protocols[name]; !ok {
		interfaceSpecInvalid(where + " references undeclared protocol " + name)
	}
}

func interfaceSpecEndpointRef(definition map[string]any, endpoint, kind string) map[string]any {
	owner, port := interfaceSpecSplitEndpoint(endpoint)
	nodes, _ := definition["nodes"].(map[string]any)
	if node, ok := nodes[owner].(map[string]any); ok {
		side := "outputs"
		if kind == "input" {
			side = "inputs"
		}
		ports, _ := node[side].(map[string]any)
		ref, _ := ports[port].(map[string]any)
		return ref
	}
	modules, _ := definition["modules"].(map[string]any)
	if module, ok := modules[owner].(map[string]any); ok {
		side := "outputs"
		if kind == "input" {
			side = "inputs"
		}
		ports, _ := module[side].(map[string]any)
		ref, _ := ports[port].(map[string]any)
		return ref
	}
	return nil
}

func interfaceSpecValidateSettings(scope string, settings map[string]any) {
	if _, ok := settings["model"]; ok {
		model, isString := settings["model"].(string)
		if !isString || strings.TrimSpace(model) == "" {
			interfaceSpecInvalid(scope + " model must name a configured connection")
		}
	}
	if _, ok := settings["retry"]; ok {
		retry, ok := settings["retry"].(map[string]any)
		if !ok {
			interfaceSpecInvalid(scope + " retry must be an object")
		}
		for key, count := range retry {
			if (key != "automatic" && key != "resubmit") || !interfaceSpecSafeNonNegative(count) {
				interfaceSpecInvalid(scope + " retry." + key + " must be a non-negative integer limit")
			}
		}
	}
	if _, ok := settings["budget"]; ok {
		budget, ok := settings["budget"].(map[string]any)
		if !ok {
			interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
		}
		for key := range budget {
			if key != "tokens" {
				interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
			}
		}
		tokens, present := budget["tokens"]
		if !present {
			interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
		}
		if tokens != nil && !interfaceSpecSafeNonNegative(tokens) {
			interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
		}
	}
}
