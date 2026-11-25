package graph

import (
	"encoding/json"
	"sort"
)

func capabilityToolAllowed(name string, tools []ToolDefinition) bool {
	for _, tool := range tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func capabilityUnique(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func capabilitySortedCopy(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

type capabilityDeclaredTool struct {
	Name        string
	Description string
}

func capabilityDeclaredTools(fact ResolvedCapabilityFact) []capabilityDeclaredTool {
	record := asMap(fact)
	raw, _ := record["declaredTools"].([]any)
	if raw == nil {
		raw, _ = record["DeclaredTools"].([]any)
	}
	out := []capabilityDeclaredTool{}
	for _, item := range raw {
		tool, _ := item.(map[string]any)
		out = append(out, capabilityDeclaredTool{Name: mapString(tool, "name", "Name"), Description: mapString(tool, "description", "Description")})
	}
	return out
}

func capabilityFactKind(fact RuntimeCapabilityLoadFact) string {
	return mapString(asMap(fact), "kind", "Kind")
}

func capabilityFactPath(fact RuntimeCapabilityLoadFact) string {
	return mapString(asMap(fact), "path", "Path")
}

func capabilityFactName(fact RuntimeCapabilityLoadFact) string {
	return mapString(asMap(fact), "name", "Name")
}

func capabilityPastedSkill(skill LoadedSkill) RuntimeCapabilityLoadFact {
	return capabilityFactFromMap(map[string]any{
		"id": skill.Name, "version": "local", "kind": "skill", "name": skill.Name, "description": skill.Description,
		"path": skill.FilePath, "loaded": true, "executable": false, "reason": "原生 skills 注入：模型按需读取 SKILL.md",
	})
}

func capabilityWithReason(fact RuntimeCapabilityLoadFact, reason string) RuntimeCapabilityLoadFact {
	record := asMap(fact)
	if record == nil {
		record = map[string]any{}
	}
	record["reason"] = reason
	return capabilityFactFromMap(record)
}

func capabilityFilterTools(fact RuntimeCapabilityLoadFact, disabled map[string]bool) RuntimeCapabilityLoadFact {
	record := asMap(fact)
	if record == nil {
		return fact
	}
	tools, ok := record["tools"].([]any)
	if !ok {
		return fact
	}
	kept := []any{}
	for _, tool := range tools {
		name, _ := tool.(string)
		if !disabled[name] {
			kept = append(kept, tool)
		}
	}
	record["tools"] = kept
	return capabilityFactFromMap(record)
}

func capabilityFactFromMap(record map[string]any) RuntimeCapabilityLoadFact {
	raw, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	var fact RuntimeCapabilityLoadFact
	if err := json.Unmarshal(raw, &fact); err != nil {
		panic(err)
	}
	return fact
}

func capabilityCopyEnv(env map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range env {
		out[key] = value
	}
	return out
}
