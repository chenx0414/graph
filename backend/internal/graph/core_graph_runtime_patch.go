package graph

import (
	"encoding/json"
)

func patchedDefinition(definition GraphDefinition, input any) any {
	if input == nil {
		Raise("invalid_input", "Graph patch must be a JSON object")
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		Raise("invalid_input", "Graph patch must contain serializable JSON")
	}
	var patch map[string]any
	if err := json.Unmarshal(encoded, &patch); err != nil {
		Raise("invalid_input", "Graph patch must be a JSON object")
	}
	base, err := json.Marshal(definition)
	if err != nil {
		Raise("invalid_input", "Graph patch must contain serializable JSON")
	}
	var result map[string]any
	if err := json.Unmarshal(base, &result); err != nil {
		panic(err)
	}
	type frame struct {
		target map[string]any
		patch  map[string]any
	}
	pending := []frame{{target: result, patch: patch}}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		for key, value := range current.patch {
			if value == nil {
				delete(current.target, key)
				continue
			}
			nested, isObject := value.(map[string]any)
			if isObject {
				existing, _ := current.target[key].(map[string]any)
				if existing == nil {
					existing = map[string]any{}
				}
				current.target[key] = existing
				pending = append(pending, frame{target: existing, patch: nested})
				continue
			}
			current.target[key] = value
		}
	}
	return result
}

func stringsTrim(value string) string {
	start := 0
	end := len(value)
	for start < end {
		c := value[start]
		if c != ' ' && c != '\n' && c != '\t' && c != '\r' {
			break
		}
		start++
	}
	for end > start {
		c := value[end-1]
		if c != ' ' && c != '\n' && c != '\t' && c != '\r' {
			break
		}
		end--
	}
	return value[start:end]
}
