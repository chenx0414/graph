package graph

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// FreezeCapabilitySettings retains literal configuration while replacing secret
// values by their original named binding, matching the durable SDK descriptor.
func FreezeCapabilitySettings(value any, credentials map[string]string) any {
	all := map[string]string{}
	for _, item := range os.Environ() {
		if key, text, ok := strings.Cut(item, "="); ok {
			all[key] = text
		}
	}
	for key, text := range credentials {
		all[key] = text
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var plain any
	if err := json.Unmarshal(raw, &plain); err != nil {
		panic(err)
	}
	return freezeCapabilitySetting(plain, all)
}

func freezeCapabilitySetting(value any, credentials map[string]string) any {
	switch value := value.(type) {
	case nil, bool, float64:
		return map[string]any{"kind": "literal", "value": value}
	case string:
		names := []string{}
		for name, text := range credentials {
			if text != "" {
				names = append(names, name)
			}
		}
		sort.Slice(names, func(i, j int) bool {
			if len(credentials[names[i]]) == len(credentials[names[j]]) {
				return names[i] < names[j]
			}
			return len(credentials[names[i]]) > len(credentials[names[j]])
		})
		parts := []any{}
		for value != "" {
			offset := -1
			selected := ""
			for _, name := range names {
				index := strings.Index(value, credentials[name])
				if index >= 0 && (offset < 0 || index < offset) {
					offset = index
					selected = name
				}
			}
			if offset < 0 {
				parts = append(parts, value)
				break
			}
			if offset > 0 {
				parts = append(parts, value[:offset])
			}
			parts = append(parts, map[string]any{"credential": selected})
			value = value[offset+len(credentials[selected]):]
		}
		return map[string]any{"kind": "string", "parts": parts}
	case []any:
		items := make([]any, len(value))
		for index, item := range value {
			items[index] = freezeCapabilitySetting(item, credentials)
		}
		return map[string]any{"kind": "array", "items": items}
	case map[string]any:
		properties := map[string]any{}
		for key, item := range value {
			properties[key] = freezeCapabilitySetting(item, credentials)
		}
		return map[string]any{"kind": "object", "properties": properties}
	default:
		panic(fmt.Errorf("Capability setting is not serializable"))
	}
}

// RestoreCapabilitySettings resolves only the original named credentials. It
// never obtains replacement literals from a currently edited capability.
func RestoreCapabilitySettings(value any, credentials map[string]string) any {
	setting := asMap(value)
	switch mapString(setting, "kind") {
	case "literal":
		return setting["value"]
	case "string":
		var text strings.Builder
		parts, _ := setting["parts"].([]any)
		for _, part := range parts {
			if literal, ok := part.(string); ok {
				text.WriteString(literal)
				continue
			}
			name := mapString(asMap(part), "credential")
			secret, ok := credentials[name]
			if !ok {
				secret, ok = os.LookupEnv(name)
			}
			if !ok {
				panic(fmt.Errorf("Frozen capability requires credential %s", name))
			}
			text.WriteString(secret)
		}
		return text.String()
	case "array":
		items, _ := setting["items"].([]any)
		restored := make([]any, len(items))
		for index, item := range items {
			restored[index] = RestoreCapabilitySettings(item, credentials)
		}
		return restored
	case "object":
		result := map[string]any{}
		for key, item := range asMap(setting["properties"]) {
			result[key] = RestoreCapabilitySettings(item, credentials)
		}
		return result
	default:
		panic(fmt.Errorf("Invalid frozen capability setting"))
	}
}
