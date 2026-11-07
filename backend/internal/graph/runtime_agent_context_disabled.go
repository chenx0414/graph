package graph

import (
	"path/filepath"
	"strings"

	"encoding/json"
)

func (library *AgentContextLibrary) DisabledTools() []string {
	path := filepath.Join(library.Root, agentContextToolStateFile)
	body, ok, err := agentContextReadOptional(path)
	if err != nil {
		panic(err)
	}
	if !ok {
		return append([]string{}, agentContextDefaultDisabledTools...)
	}
	var state any
	if err := json.Unmarshal([]byte(body), &state); err != nil {
		panic(err)
	}
	record := asMap(state)
	if record == nil {
		Raise("invalid_config", path+" must contain a disabled string array")
	}
	raw, _ := record["disabled"].([]any)
	if raw == nil {
		Raise("invalid_config", path+" must contain a disabled string array")
	}
	names := []string{}
	for _, item := range raw {
		name, isString := item.(string)
		if !isString || strings.TrimSpace(name) == "" {
			Raise("invalid_config", path+" must contain a disabled string array")
		}
		names = append(names, strings.TrimSpace(name))
	}
	return agentContextUniqueSorted(names)
}

func (library *AgentContextLibrary) SetDisabledTools(values []string) []string {
	candidates := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}
	disabled := agentContextUniqueSorted(candidates)
	for _, name := range disabled {
		if len(name) > agentContextMaxToolNameLength || strings.ContainsAny(name, "\x00\r\n") {
			Raise("invalid_input", "Invalid tool name "+name)
		}
	}
	body, err := json.MarshalIndent(agentToolStateFile{Version: 1, Disabled: disabled}, "", "  ")
	if err != nil {
		panic(err)
	}
	agentContextWriteAtomic(filepath.Join(library.Root, agentContextToolStateFile), string(body)+"\n")
	return disabled
}
