package graph

import (
	"os"
	"path/filepath"
	"strings"
)

func agentContextTrimEnd(value string) string {
	return strings.TrimRightFunc(value, agentContextIsSpace)
}

func agentContextIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func agentContextWriteAtomic(path, content string) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		panic(err)
	}
	pending := path + "." + itoa(os.Getpid()) + ".pending"
	if err := os.WriteFile(pending, []byte(content), 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(pending, path); err != nil {
		panic(err)
	}
}

func agentContextWriteNew(path, content string) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return
		}
		panic(err)
	}
	defer file.Close()
	if _, err := file.WriteString(content); err != nil {
		panic(err)
	}
}

func agentContextReadOptional(path string) (string, bool, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(body), true, nil
}

func agentContextReadRequired(path string) string {
	body, ok, err := agentContextReadOptional(path)
	if err != nil {
		panic(err)
	}
	if !ok {
		panic(os.ErrNotExist)
	}
	return body
}

var agentLegacyPromptPaths = map[AgentPromptKey]string{
	"tools/main.md": "tool-awareness.md",
}

func render(content string, variables map[string]string) string {
	return agentContextPromptVariablePattern.ReplaceAllStringFunc(content, func(match string) string {
		name := agentContextPromptVariablePattern.FindStringSubmatch(match)[1]
		return variables[name]
	})
}

func RenderAgentPrompt(content string, variables map[string]string) string {
	return render(content, variables)
}

func agentContextPath(root, key string) string {
	return filepath.Join(root, filepath.FromSlash(key))
}

func agentPath(root, definitionID string) string {
	if !agentContextDefinitionIDPattern.MatchString(definitionID) {
		Raise("invalid_input", "Invalid Agent definition id "+definitionID)
	}
	return filepath.Join(root, "agents", definitionID+".md")
}
