package graph

import (
	"fmt"
	"math"
	"strings"
)

type interfaceSpecError struct {
	Keyword      string
	InstancePath string
	Message      string
	Params       map[string]any
}

var interfaceSpecKeywords = map[string]bool{
	"type": true, "properties": true, "required": true, "additionalProperties": true, "items": true,
	"minLength": true, "maxLength": true, "minimum": true, "maximum": true, "minItems": true, "maxItems": true,
	"enum": true, "const": true, "pattern": true, "version": true, "description": true, "title": true,
	"default": true, "examples": true, "$schema": true, "$id": true, "$comment": true, "format": true,
	"$ref": true, "anyOf": true, "oneOf": true, "allOf": true, "not": true, "if": true, "then": true, "else": true,
}

var interfaceSpecValidators []struct {
	signature string
	schema    map[string]any
}

func interfaceSpecCompile(spec map[string]any) map[string]any {
	signature := jsonStringify(spec)
	for _, cached := range interfaceSpecValidators {
		if cached.signature == signature {
			return cached.schema
		}
	}
	for key, value := range spec {
		if !interfaceSpecKeywords[key] {
			panic(fmt.Errorf("strict mode: unknown keyword: %q", key))
		}
		if key == "version" {
			if _, ok := value.(float64); !ok {
				panic(fmt.Errorf("keyword \"version\" value must be number"))
			}
		}
	}
	if len(interfaceSpecValidators) >= 1000 {
		interfaceSpecValidators = interfaceSpecValidators[1:]
	}
	interfaceSpecValidators = append(interfaceSpecValidators, struct {
		signature string
		schema    map[string]any
	}{signature, spec})
	return spec
}

func interfaceSpecCheck(schema map[string]any, value any, path string) *interfaceSpecError {
	if schema == nil {
		return nil
	}
	if types, ok := schema["type"].([]any); ok {
		matched := false
		names := []string{}
		for _, item := range types {
			name, _ := item.(string)
			names = append(names, name)
			if interfaceSpecTypeOK(name, value) {
				matched = true
			}
		}
		if !matched {
			return &interfaceSpecError{Keyword: "type", InstancePath: path, Message: "must be " + strings.Join(names, ","), Params: map[string]any{"type": strings.Join(names, ",")}}
		}
	} else if name, ok := schema["type"].(string); ok && !interfaceSpecTypeOK(name, value) {
		return &interfaceSpecError{Keyword: "type", InstancePath: path, Message: "must be " + name, Params: map[string]any{"type": name}}
	}
	if required, ok := schema["required"].([]any); ok {
		record, _ := value.(map[string]any)
		for _, item := range required {
			name, _ := item.(string)
			if record == nil || record[name] == nil && !interfaceSpecHasKey(record, name) {
				return &interfaceSpecError{Keyword: "required", InstancePath: path, Message: "must have required property '" + name + "'", Params: map[string]any{"missingProperty": name}}
			}
		}
	}
	if limit, ok := schema["minLength"].(float64); ok {
		text, _ := value.(string)
		if utf16Len(text) < int(limit) {
			return &interfaceSpecError{Keyword: "minLength", InstancePath: path, Message: fmt.Sprintf("must NOT have fewer than %v characters", limit)}
		}
	}
	if limit, ok := schema["minimum"].(float64); ok {
		number, ok := asFloat(value)
		if ok && number < limit {
			return &interfaceSpecError{Keyword: "minimum", InstancePath: path, Message: fmt.Sprintf("must be >= %v", limit)}
		}
	}
	if name, _ := schema["type"].(string); name == "integer" {
		if !interfaceSpecTypeOK("integer", value) {
			return &interfaceSpecError{Keyword: "type", InstancePath: path, Message: "must be integer", Params: map[string]any{"type": "integer"}}
		}
	}
	if properties, ok := schema["properties"].(map[string]any); ok {
		if record, ok := value.(map[string]any); ok {
			for key, child := range record {
				childSchema, ok := properties[key].(map[string]any)
				if !ok {
					continue
				}
				if err := interfaceSpecCheck(childSchema, child, path+"/"+interfaceSpecEscape(key)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func interfaceSpecHasKey(record map[string]any, key string) bool {
	if record == nil {
		return false
	}
	_, ok := record[key]
	return ok
}

func interfaceSpecEscape(key string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(key)
}

func interfaceSpecTypeOK(name string, value any) bool {
	switch name {
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "null":
		return value == nil
	case "number":
		_, ok := asFloat(value)
		return ok
	case "integer":
		number, ok := asFloat(value)
		return ok && number == math.Trunc(number) && !math.IsNaN(number) && !math.IsInf(number, 0)
	default:
		return false
	}
}

// ValidateProtocolValue checks one value against the receiving protocol and never rewrites it.
func ValidateProtocolValue(spec ProtocolSpec, value Json, path string) *string {
	defer func() {
		_ = recover()
	}()
	validate := interfaceSpecCompile(spec)
	if err := interfaceSpecCheck(validate, value, ""); err == nil {
		return nil
	} else {
		hint := ""
		if spec["type"] == "object" && err.Keyword == "type" && err.InstancePath == "" && err.Params["type"] == "object" {
			if _, isString := value.(string); isString {
				hint = " Received a string; pass the object directly as the JSON value, not as a JSON-encoded string."
			}
		}
		root := path
		if root == "" {
			root = "(root)"
		}
		message := root + err.InstancePath + ": " + err.Message + hint
		return &message
	}
}
