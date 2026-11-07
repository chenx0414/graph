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
		if key == "type" {
			names, ok := interfaceSpecTypeNames(value)
			if !ok {
				panic(fmt.Errorf("keyword \"type\" value must be string or array of strings"))
			}
			for _, name := range names {
				if !interfaceSpecTypeKnown(name) {
					panic(fmt.Errorf("keyword \"type\" value must be a known type name"))
				}
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
	if expected, ok := schema["const"]; ok && !interfaceSpecJSONEqual(value, expected) {
		return &interfaceSpecError{Keyword: "const", InstancePath: path, Message: "must be equal to constant"}
	}
	if allowed, ok := schema["enum"].([]any); ok {
		matched := false
		for _, item := range allowed {
			if interfaceSpecJSONEqual(value, item) {
				matched = true
				break
			}
		}
		if !matched {
			return &interfaceSpecError{Keyword: "enum", InstancePath: path, Message: "must be equal to one of the allowed values"}
		}
	}
	if limit, ok := schema["maxLength"].(float64); ok {
		text, _ := value.(string)
		if utf16Len(text) > int(limit) {
			return &interfaceSpecError{Keyword: "maxLength", InstancePath: path, Message: fmt.Sprintf("must NOT have more than %v characters", limit)}
		}
	}
	if limit, ok := schema["maximum"].(float64); ok {
		number, ok := asFloat(value)
		if ok && number > limit {
			return &interfaceSpecError{Keyword: "maximum", InstancePath: path, Message: fmt.Sprintf("must be <= %v", limit)}
		}
	}
	if pattern, ok := schema["pattern"].(string); ok {
		text, isString := value.(string)
		if isString {
			matcher, err := interfaceSpecPattern(pattern)
			if err != nil {
				return &interfaceSpecError{Keyword: "pattern", InstancePath: path, Message: "must match pattern " + pattern}
			}
			if !matcher.MatchString(text) {
				return &interfaceSpecError{Keyword: "pattern", InstancePath: path, Message: "must match pattern " + pattern}
			}
		}
	}
	if items, ok := value.([]any); ok {
		if limit, ok := schema["minItems"].(float64); ok && float64(len(items)) < limit {
			return &interfaceSpecError{Keyword: "minItems", InstancePath: path, Message: fmt.Sprintf("must NOT have fewer than %v items", limit)}
		}
		if limit, ok := schema["maxItems"].(float64); ok && float64(len(items)) > limit {
			return &interfaceSpecError{Keyword: "maxItems", InstancePath: path, Message: fmt.Sprintf("must NOT have more than %v items", limit)}
		}
		if unique, _ := schema["uniqueItems"].(bool); unique {
			seen := []string{}
			for _, item := range items {
				encoded := jsonStringify(item)
				for _, held := range seen {
					if held == encoded {
						return &interfaceSpecError{Keyword: "uniqueItems", InstancePath: path, Message: "must NOT have duplicate items"}
					}
				}
				seen = append(seen, encoded)
			}
		}
		switch declared := schema["items"].(type) {
		case map[string]any:
			for index, item := range items {
				if err := interfaceSpecCheck(declared, item, path+"/"+itoa(index)); err != nil {
					return err
				}
			}
		case []any:
			for index, item := range items {
				if index >= len(declared) {
					break
				}
				child, _ := declared[index].(map[string]any)
				if child == nil {
					continue
				}
				if err := interfaceSpecCheck(child, item, path+"/"+itoa(index)); err != nil {
					return err
				}
			}
		}
	}
	if properties, ok := schema["properties"].(map[string]any); ok {
		if record, ok := value.(map[string]any); ok {
			additional, hasAdditional := schema["additionalProperties"]
			additionalSchema, additionalIsSchema := additional.(map[string]any)
			allowed, explicitlyClosed := additional.(bool)
			for key, child := range record {
				childSchema, ok := properties[key].(map[string]any)
				if !ok {
					if hasAdditional && additionalIsSchema {
						if err := interfaceSpecCheck(additionalSchema, child, path+"/"+interfaceSpecEscape(key)); err != nil {
							return err
						}
						continue
					}
					if hasAdditional && explicitlyClosed && !allowed {
						return &interfaceSpecError{Keyword: "additionalProperties", InstancePath: path, Message: "must NOT have additional properties"}
					}
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
