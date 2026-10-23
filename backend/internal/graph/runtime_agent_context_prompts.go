package graph

import (
	"os"
	"path/filepath"
	"strings"
)

// Ensure seeds the library on first launch. It never overwrites an existing file.
func (library *AgentContextLibrary) Ensure() {
	if err := os.MkdirAll(library.Root, 0o700); err != nil {
		panic(err)
	}
	readme := strings.Join([]string{
		"# Graph Agent Context Library",
		"",
		"These files are read before the next Agent operation and can be edited here or in Graph.",
		"Graph seeds the defaults on first launch and never overwrites an existing file.",
		"Use Reset in the Agent Context panel to restore the original built-in version.",
		"",
		"identity: agents/",
		"tool guidance: tools/",
		"rules: rules/",
		"runtime-only prompts: runtime/",
		"user-defined reset defaults: defaults/ (may be empty)",
		"read-only Agent docs: <application>/docs/agent/",
	}, "\n")
	agentContextWriteNew(filepath.Join(library.Root, "README.md"), readme+"\n")
	for _, descriptor := range library.descriptors() {
		key := string(descriptor.Key)
		if err := os.MkdirAll(filepath.Dir(descriptor.File), 0o700); err != nil {
			panic(err)
		}
		userDefault, hasUserDefault, err := library.userDefault(key)
		if err != nil {
			panic(err)
		}
		legacyPath, hasLegacy := agentLegacyPromptPaths[key]
		legacy := ""
		if hasLegacy {
			value, ok, err := agentContextReadOptional(agentContextPath(library.Root, legacyPath))
			if err != nil {
				panic(err)
			}
			if ok {
				legacy = value
			}
		}
		seed := descriptor.Content
		if hasUserDefault {
			seed = userDefault
		} else if strings.TrimSpace(legacy) != "" {
			seed = legacy
		}
		agentContextWriteNew(descriptor.File, agentContextTrimEnd(seed)+"\n")
		if hasUserDefault {
			continue
		}
		current, ok, err := agentContextReadOptional(descriptor.File)
		if err != nil {
			panic(err)
		}
		if !ok {
			continue
		}
		migrated := current
		for _, value := range agentLegacyPromptDefaults[key] {
			if agentContextTrimEnd(current) == agentContextTrimEnd(value) {
				migrated = agentContextTrimEnd(descriptor.Content) + "\n"
				break
			}
		}
		for _, pair := range agentLegacyPromptReplacements[key] {
			migrated = strings.Replace(migrated, pair[0], pair[1], 1)
		}
		if migrated != current {
			agentContextWriteAtomic(descriptor.File, migrated)
		}
	}
}

// Prompt renders the effective text of one prompt. An unknown key is refused
// with the error the TypeScript library rejected its promise with.
func (library *AgentContextLibrary) Prompt(key AgentPromptKey, variables ...map[string]string) (result string, err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		failure, ok := recovered.(*RuntimeError)
		if !ok {
			panic(recovered)
		}
		result, err = "", failure
	}()
	values := map[string]string{}
	if len(variables) > 0 && variables[0] != nil {
		values = variables[0]
	}
	if library.overlay != nil {
		if text, ok := library.overlay[string(key)]; ok && strings.TrimSpace(text) != "" {
			return agentContextTrimEnd(render(text, values)), nil
		}
	}
	custom, hasCustom, err := library.Override(key)
	if err != nil {
		return "", err
	}
	fallback, err := library.effectiveDefault(key)
	if err != nil {
		return "", err
	}
	if hasCustom {
		return agentContextTrimEnd(render(custom, values)), nil
	}
	return agentContextTrimEnd(render(fallback, values)), nil
}

// AgentPrompt is the identity override of one published Agent definition.
func (library *AgentContextLibrary) AgentPrompt(definitionID string, fallback *string) string {
	ids := []string{definitionID}
	if definitionID == "master" {
		ids = []string{"main", "master"}
	}
	for _, id := range ids {
		if library.overlay != nil {
			if text, ok := library.overlay["agents/"+id+".md"]; ok && strings.TrimSpace(text) != "" {
				return agentContextTrimEnd(text)
			}
		}
		custom, ok, err := agentContextReadOptional(agentPath(library.Root, id))
		if err != nil {
			panic(err)
		}
		if ok {
			return agentContextTrimEnd(custom)
		}
	}
	if definitionID == "main" || definitionID == "master" {
		if fallback != nil {
			if trimmed := strings.TrimSpace(*fallback); trimmed != "" {
				return trimmed
			}
		}
		return library.defaults.Identity
	}
	if fallback != nil {
		return strings.TrimSpace(*fallback)
	}
	return ""
}

// Override is the user-edited text of one prompt, if there is one.
func (library *AgentContextLibrary) Override(key AgentPromptKey) (string, bool, error) {
	current, ok, err := agentContextReadOptional(library.promptPath(key))
	if err != nil {
		return "", false, err
	}
	if ok {
		return current, true, nil
	}
	legacyPath, hasLegacy := agentLegacyPromptPaths[key]
	if !hasLegacy {
		return "", false, nil
	}
	value, ok, err := agentContextReadOptional(agentContextPath(library.Root, legacyPath))
	if err != nil {
		return "", false, err
	}
	return value, ok, nil
}

// SavePrompt writes the user-edited text of one prompt.
func (library *AgentContextLibrary) SavePrompt(key AgentPromptKey, content string) {
	if len(content) > agentContextMaxPromptLength {
		Raise("invalid_input", "Prompt content must be at most 250000 characters")
	}
	agentContextWriteAtomic(library.promptPath(key), agentContextTrimEnd(content)+"\n")
}

// SetPromptDefault writes the user-owned reset default and the prompt itself.
func (library *AgentContextLibrary) SetPromptDefault(key AgentPromptKey, content string) {
	if len(content) > agentContextMaxPromptLength {
		Raise("invalid_input", "Prompt content must be at most 250000 characters")
	}
	normalized := agentContextTrimEnd(content) + "\n"
	agentContextWriteAtomic(library.userDefaultPath(key), normalized)
	agentContextWriteAtomic(library.promptPath(key), normalized)
}

// ClearPromptDefault drops the user-owned reset default and restores the built-in.
func (library *AgentContextLibrary) ClearPromptDefault(key AgentPromptKey) {
	if err := os.Remove(library.userDefaultPath(key)); err != nil && !os.IsNotExist(err) {
		panic(err)
	}
	builtIn := library.builtInContent(key)
	agentContextWriteAtomic(library.promptPath(key), agentContextTrimEnd(builtIn)+"\n")
}

// ResetPrompt restores the effective default of one prompt.
func (library *AgentContextLibrary) ResetPrompt(key AgentPromptKey) {
	fallback, err := library.effectiveDefault(key)
	if err != nil {
		panic(err)
	}
	agentContextWriteAtomic(library.promptPath(key), agentContextTrimEnd(fallback)+"\n")
}
