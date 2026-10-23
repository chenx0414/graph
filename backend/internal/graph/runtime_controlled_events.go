package graph

import (
	"sort"
	"strings"
)

// controlledSystemPrompt reads the system prompt one context carries.
//
// The prompt is what every system message of the transcript replays to, never the plain
// field: the provider receives the replayed prompt, so the console must show that same
// text.
func controlledSystemPrompt(context map[string]any) string {
	head := controlledCurrentSystemMessage(controlledContextMessages(context))
	if head == nil || !head.present() {
		return ""
	}
	return head.text()
}

// controlledSystemPromptPointer reads the system prompt one context carries.
func controlledSystemPromptPointer(context map[string]any) *string {
	prompt := controlledSystemPrompt(context)
	if prompt == "" {
		return nil
	}
	return &prompt
}

// controlledNormalizeContext folds the system prompt and the tool set into one leading
// system message.
//
// The Pi SDK's normalizeContext is the only entry point that produces a transcript
// context, and every provider-facing call expects the result. It is idempotent: a context
// that already carries its prompt in the transcript is left alone.
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

// controlledSystemMessage is the leading system message of a transcript: the current
// prompt, the prompt sections and the tools the model may call.
type controlledSystemMessage struct {
	content      string
	sections     *controlledSectionList
	tools        []any
	timestamp    any
	hasTimestamp bool
}

// present reports whether the transcript carried a system message at all.
func (head *controlledSystemMessage) present() bool {
	return head.hasTimestamp || len(head.tools) > 0
}

// text renders the system message as a complete prompt: its content followed by its
// sections.
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

// controlledCurrentSystemMessage replays every system message of a transcript into the one
// leading system message that holds the current prompt and the current tools.
//
// Later content is appended to the base prompt, the sections are patched by name and the
// tools are resolved by replaying every tool delta in order.
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

// controlledContentText joins the text blocks of one message content.
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

// controlledCurrentTools resolves the tools available after applying every transcript
// delta in order.
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

// controlledMessageTools reads the tool list one transcript field carries.
func controlledMessageTools(value any) []any {
	tools, _ := value.([]any)
	return tools
}

// controlledToolName reads the name of one tool declaration.
func controlledToolName(tool any) string {
	declaration, ok := tool.(map[string]any)
	if !ok {
		return ""
	}
	name, _ := declaration["name"].(string)
	return name
}

// controlledSectionList is one system message's prompt sections, in the order the
// transcript declared them.
//
// The Pi SDK writes the sections in a fixed order and the rendered prompt keeps that
// order, so the sections keep their own shape instead of a plain map.
type controlledSectionList struct {
	names  []string
	values map[string]any
}

// merge applies one section patch. A null value removes the section, a text value sets it.
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
		// TODO(port): a plain map has no insertion order, so the sections are read by name.
		sort.Strings(names)
		for _, name := range names {
			list.set(name, typed[name])
		}
	}
}

// set stores one section, keeping the position of a name that is already known.
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

// remove drops one section.
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

// texts returns the section values in transcript order.
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

// controlledInstructionRole is the role the provider's instruction message carries.
//
// A reasoning model on a provider that accepts the `developer` role gets it; every
// other provider gets `system`. The SDK detects the provider's answer from its name
// and its base URL, and so does this.
func controlledInstructionRole(model map[string]any) string {
	reasoning, _ := model["reasoning"].(bool)
	if !reasoning {
		return "system"
	}
	provider, _ := model["provider"].(string)
	baseURL, _ := model["baseUrl"].(string)
	modelID, _ := model["id"].(string)
	if controlledSupportsDeveloperRole(provider, baseURL, modelID) {
		return "developer"
	}
	return "system"
}

// controlledSupportsDeveloperRole reports whether the provider accepts the `developer`
// role instead of `system`.
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

// controlledOpenAIMessages turns a transcript into OpenAI messages.
//
// The system messages collapse into the one leading system message a chat completions
// request carries the prompt in. The instruction role is the one the provider accepts:
// a reasoning model on a standard provider gets `developer`, everything else `system`.
func controlledOpenAIMessages(messages []any, instructionRole string) []any {
	out := []any{}
	head := controlledCurrentSystemMessage(messages)
	if head.present() {
		if text := head.text(); text != "" {
			out = append(out, map[string]any{"role": instructionRole, "content": text})
		}
	}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "toolResult":
			out = append(out, map[string]any{
				"role": "tool", "tool_call_id": message["toolCallId"],
				"content": ControlledTextFromContent(message["content"]),
			})
		case "system", "developer":
			continue
		case "assistant":
			assistant, ok := controlledOpenAIAssistant(message)
			if !ok {
				continue
			}
			out = append(out, assistant)
		default:
			out = append(out, map[string]any{"role": "user", "content": ControlledTextFromContent(message["content"])})
		}
	}
	return out
}

// controlledOpenAIAssistant renders one assistant message the way the SDK does.
//
// The assistant keeps its own role: a model that reads its own tool call back as a
// user turn does not recognize the call it made, and a tool result without the
// assistant turn that asked for it is a request no provider accepts. The text is
// the content, and every tool call the message made is an OpenAI tool call.
func controlledOpenAIAssistant(message map[string]any) (map[string]any, bool) {
	text := ""
	calls := []any{}
	content, _ := message["content"].([]any)
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			if value, ok := block["text"].(string); ok {
				text += value
			}
		case "toolCall":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if name == "" {
				continue
			}
			calls = append(calls, map[string]any{
				"id": id, "type": "function",
				"function": map[string]any{"name": name, "arguments": stringifyJSON(block["arguments"])},
			})
		}
	}
	if text == "" && len(calls) == 0 {
		// The SDK skips an assistant message that carries neither text nor a tool
		// call; an empty one is a request no provider accepts.
		return nil, false
	}
	assistant := map[string]any{"role": "assistant", "content": nil}
	if text != "" {
		assistant["content"] = text
	}
	if len(calls) > 0 {
		assistant["tool_calls"] = calls
	}
	return assistant, true
}

// controlledAnthropicMessages turns a transcript into Anthropic messages.
func controlledAnthropicMessages(messages []any) []any {
	out := []any{}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "toolResult":
			out = append(out, map[string]any{
				"role": "user",
				"content": []any{map[string]any{
					"type": "tool_result", "tool_use_id": message["toolCallId"],
					"content": ControlledTextFromContent(message["content"]),
				}},
			})
		case "assistant":
			out = append(out, map[string]any{"role": "assistant", "content": ControlledTextFromContent(message["content"])})
		case "system", "developer":
			continue
		default:
			out = append(out, map[string]any{"role": "user", "content": ControlledTextFromContent(message["content"])})
		}
	}
	return out
}

// controlledContextMessages reads the messages one context carries.
func controlledContextMessages(context map[string]any) []any {
	if context == nil {
		return nil
	}
	messages, _ := context["messages"].([]any)
	return messages
}

// controlledOpenAITools turns the transcript tools into OpenAI tool declarations.
func controlledOpenAITools(messages []any) []any {
	out := []any{}
	for _, tool := range controlledCurrentTools(messages) {
		declaration, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := declaration["name"].(string)
		if name == "" {
			continue
		}
		description, _ := declaration["description"].(string)
		function := map[string]any{"name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			function["parameters"] = parameters
		}
		out = append(out, map[string]any{"type": "function", "function": function})
	}
	return out
}

// controlledAnthropicTools turns the transcript tools into Anthropic tool declarations.
func controlledAnthropicTools(messages []any) []any {
	out := []any{}
	for _, tool := range controlledCurrentTools(messages) {
		declaration, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := declaration["name"].(string)
		if name == "" {
			continue
		}
		description, _ := declaration["description"].(string)
		tool := map[string]any{"name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			tool["input_schema"] = parameters
		}
		out = append(out, tool)
	}
	return out
}

// controlledContextTools reads the tool declarations one context carries.
func controlledContextTools(context map[string]any) []any {
	if context == nil {
		return nil
	}
	tools, _ := context["tools"].([]any)
	return tools
}
