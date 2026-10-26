package graph

import (
	"strings"
)

func ResolveEmit(value EmitValue, environment RuleEnvironment) any {
	switch value.Kind {
	case "literal":
		return value.Value
	case "forward":
		if item, ok := environment.Inputs[value.Input]; ok {
			return item
		}
		return nil
	case "field":
		found, read := ruleReadPath(strings.Split(value.Path, "."), environment)
		if found {
			return read
		}
		return nil
	case "object":
		out := map[string]any{}
		for key, child := range value.Fields {
			out[key] = ResolveEmit(child, environment)
		}
		return out
	default:
		return nil
	}
}

func ParseEmit(source map[string]any) map[string]EmitValue {
	out := map[string]EmitValue{}
	for port, value := range source {
		out[port] = parseEmitValue(value)
	}
	return out
}

func parseEmitValue(value any) EmitValue {
	if text, ok := value.(string); ok {
		if strings.HasPrefix(text, "$") {
			return EmitValue{Kind: "forward", Input: text[1:]}
		}
		if emitFieldPattern(text) {
			return EmitValue{Kind: "field", Path: text}
		}
		return EmitValue{Kind: "literal", Value: text}
	}
	object, ok := value.(map[string]any)
	if ok {
		fields := map[string]EmitValue{}
		for key, child := range object {
			fields[key] = parseEmitValue(child)
		}
		return EmitValue{Kind: "object", Fields: fields}
	}
	return EmitValue{Kind: "literal", Value: value}
}

func emitFieldPattern(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	for index, part := range parts {
		if part == "" {
			return false
		}
		for i, r := range part {
			if i == 0 {
				if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || r == '_') {
					return false
				}
				continue
			}
			if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_') {
				return false
			}
		}
		_ = index
	}
	return true
}
