package graph

import (
	"strings"

	"sort"
)

func controlledSystemPrompt(context map[string]any) string {
	head := controlledCurrentSystemMessage(controlledContextMessages(context))
	if head == nil || !head.present() {
		return ""
	}
	return head.text()
}

func controlledSystemPromptPointer(context map[string]any) *string {
	prompt := controlledSystemPrompt(context)
	if prompt == "" {
		return nil
	}
	return &prompt
}

func controlledNormalizeContext(context map[string]any) map[string]any {
	if context == nil {
		return nil
	}
	messages := controlledContextMessages(context)
	systemPrompt, hasPrompt := context["systemPrompt"].(string)
	tools := controlledContextTools(context)
	if (!hasPrompt || systemPrompt == "") && len(tools) == 0 {
		return map[string]any{"messages": messages}
	}
	initial := map[string]any{"role": "system", "content": systemPrompt, "timestamp": float64(0)}
	if len(tools) > 0 {
		initial["toolsAdded"] = tools
	}
	return map[string]any{"messages": append([]any{initial}, messages...)}
}

type controlledSystemMessage struct {
	content      string
	sections     *controlledSectionList
	tools        []any
	timestamp    any
	hasTimestamp bool
}

func (head *controlledSystemMessage) present() bool {
	return head.hasTimestamp || len(head.tools) > 0
}

func (head *controlledSystemMessage) text() string {
	parts := []string{head.content}
	parts = append(parts, head.sections.texts()...)
	kept := []string{}
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n\n")
}

func controlledCurrentSystemMessage(messages []any) *controlledSystemMessage {
	head := &controlledSystemMessage{sections: &controlledSectionList{values: map[string]any{}}}
	content := []string{}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if role, _ := message["role"].(string); role != "system" {
			continue
		}
		if !head.hasTimestamp {
			if timestamp, present := message["timestamp"]; present {
				head.timestamp = timestamp
				head.hasTimestamp = true
			}
		}
		text := controlledContentText(message["content"])
		if text != "" {
			content = append(content, text)
		}
		head.sections.merge(message["sections"])
	}
	head.content = strings.Join(content, "\n\n")
	head.tools = controlledCurrentTools(messages)
	return head
}

func controlledContentText(content any) string {
	switch typed := content.(type) {
	case string:
		return typed
	case []any:
		parts := []string{}
		for _, item := range typed {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if kind, _ := block["type"].(string); kind != "text" {
				continue
			}
			text, _ := block["text"].(string)
			parts = append(parts, text)
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func controlledCurrentTools(messages []any) []any {
	names := []string{}
	values := map[string]any{}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if role, _ := message["role"].(string); role != "system" {
			continue
		}
		for _, tool := range controlledMessageTools(message["toolsRemoved"]) {
			name := controlledToolName(tool)
			if name == "" {
				continue
			}
			if _, present := values[name]; !present {
				continue
			}
			delete(values, name)
			for index, known := range names {
				if known == name {
					names = append(names[:index], names[index+1:]...)
					break
				}
			}
		}
		for _, tool := range controlledMessageTools(message["toolsAdded"]) {
			name := controlledToolName(tool)
			if name == "" {
				continue
			}
			if _, present := values[name]; !present {
				names = append(names, name)
			}
			values[name] = tool
		}
	}
	out := []any{}
	for _, name := range names {
		out = append(out, values[name])
	}
	return out
}

func controlledMessageTools(value any) []any {
	tools, _ := value.([]any)
	return tools
}

func controlledToolName(tool any) string {
	declaration, ok := tool.(map[string]any)
	if !ok {
		return ""
	}
	name, _ := declaration["name"].(string)
	return name
}

type controlledSectionList struct {
	names  []string
	values map[string]any
}

func (list *controlledSectionList) merge(patch any) {
	switch typed := patch.(type) {
	case *controlledSectionList:
		for _, name := range typed.names {
			list.set(name, typed.values[name])
		}
	case map[string]any:
		names := make([]string, 0, len(typed))
		for name := range typed {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			list.set(name, typed[name])
		}
	}
}

func (list *controlledSectionList) set(name string, value any) {
	if value == nil {
		list.remove(name)
		return
	}
	if list.values == nil {
		list.values = map[string]any{}
	}
	if _, present := list.values[name]; !present {
		list.names = append(list.names, name)
	}
	list.values[name] = value
}

func (list *controlledSectionList) remove(name string) {
	if _, present := list.values[name]; !present {
		return
	}
	delete(list.values, name)
	for index, known := range list.names {
		if known == name {
			list.names = append(list.names[:index], list.names[index+1:]...)
			break
		}
	}
}

func (list *controlledSectionList) texts() []string {
	out := []string{}
	for _, name := range list.names {
		value, present := list.values[name]
		if !present || value == nil {
			continue
		}
		text, isText := value.(string)
		if !isText {
			continue
		}
		out = append(out, text)
	}
	return out
}

func controlledInstructionRole(model map[string]any) string {
	reasoning, _ := model["reasoning"].(bool)
	if !reasoning {
		return "system"
	}
	if controlledCompatFor(model).supportsDeveloperRole {
		return "developer"
	}
	return "system"
}

func controlledSupportsDeveloperRole(provider, baseURL, modelID string) bool {
	lowered := strings.ToLower(baseURL)
	isOpenRouter := provider == "openrouter" || strings.Contains(lowered, "openrouter.ai")
	nonStandard := provider == "xai" || strings.Contains(lowered, "api.x.ai") ||
		provider == "nvidia" || strings.Contains(lowered, "integrate.api.nvidia.com") ||
		provider == "cerebras" || strings.Contains(lowered, "cerebras.ai") ||
		provider == "together" || strings.Contains(lowered, "api.together.ai") || strings.Contains(lowered, "api.together.xyz") ||
		strings.Contains(lowered, "chutes.ai") ||
		provider == "deepseek" || strings.Contains(lowered, "deepseek.com") ||
		provider == "zai" || provider == "zai-coding-cn" || strings.Contains(lowered, "api.z.ai") || strings.Contains(lowered, "open.bigmodel.cn") ||
		provider == "moonshotai" || provider == "moonshotai-cn" || strings.Contains(lowered, "api.moonshot.") ||
		provider == "opencode" || strings.Contains(lowered, "opencode.ai") ||
		provider == "cloudflare-workers-ai" || strings.Contains(lowered, "api.cloudflare.com") ||
		provider == "cloudflare-ai-gateway" || strings.Contains(lowered, "gateway.ai.cloudflare.com") ||
		provider == "ant-ling" || strings.Contains(lowered, "api.ant-ling.com")
	if isOpenRouter && (strings.HasPrefix(modelID, "anthropic/") || strings.HasPrefix(modelID, "openai/")) {
		return true
	}
	return !nonStandard && !isOpenRouter
}
