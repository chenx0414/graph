package graph

import (
	"regexp"
	"strings"

	"encoding/json"
)

type PromptSuggestionReply struct {
	Text       string  `json:"text"`
	Raw        string  `json:"raw"`
	StopReason *string `json:"stopReason"`
	Error      *string `json:"error"`
}

var NO_SUGGESTION = PromptSuggestionReply{Text: "", Raw: "", StopReason: nil, Error: nil}

var (
	promptFence  = regexp.MustCompile("(?i)^```(?:text)?\\s*([\\s\\S]*?)```$")
	promptPrefix = regexp.MustCompile("(?i)^(?:suggestion|prompt|候选提示|建议|下一步)\\s*[:：]\\s*")
	promptNone   = regexp.MustCompile("(?i)^(?:none|n/a|no suggestion|没有建议|无)$")
)

func SelectPromptSuggestionModel(main ModelEntry, directory []ModelEntry) *ModelEntry {
	mainIdentity := ModelIdentity(main)
	candidates := []ModelEntry{}
	for _, model := range directory {
		if model.Id != main.Id && ModelIdentity(model) != mainIdentity {
			candidates = append(candidates, model)
		}
	}
	if len(candidates) > 0 {
		return &candidates[0]
	}
	return nil
}

func promptSuggestionTextFromMessage(message map[string]any) string {
	parts, ok := message["content"].([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, part := range parts {
		record, ok := part.(map[string]any)
		if !ok || record["type"] != "text" {
			continue
		}
		if text, ok := record["text"].(string); ok {
			b.WriteString(text)
		}
	}
	return b.String()
}

func normalizeSuggestion(value string) string {
	text := strings.TrimSpace(value)
	if fence := promptFence.FindStringSubmatch(text); fence != nil {
		text = strings.TrimSpace(fence[1])
	}
	text = strings.TrimSpace(promptPrefix.ReplaceAllString(text, ""))
	runes := []rune(text)
	if len(runes) >= 2 && ((runes[0] == '"' && runes[len(runes)-1] == '"') || (runes[0] == '“' && runes[len(runes)-1] == '”')) {
		text = strings.TrimSpace(string(runes[1 : len(runes)-1]))
	}
	first := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			first = line
			break
		}
	}
	if promptNone.MatchString(first) {
		return ""
	}
	firstRunes := []rune(first)
	if len(firstRunes) > 500 {
		return string(firstRunes[:500])
	}
	return first
}

func GeneratePromptSuggestion(input struct {
	Stream         PromptStreamFunc
	Model          any
	UserMessage    string
	AssistantReply string
	SystemPrompt   string
	Signal         any
}) PromptSuggestionReply {
	system := strings.TrimSpace(input.SystemPrompt)
	if system == "" {
		system = DEFAULT_PROMPT_SUGGESTION_PROMPT
	}
	user := input.UserMessage
	if len([]rune(user)) > 2000 {
		user = string([]rune(user)[:2000])
	}
	reply := input.AssistantReply
	if len([]rune(reply)) > 8000 {
		reply = string([]rune(reply)[:8000])
	}
	body, err := json.Marshal(map[string]string{"lastUserMessage": user, "assistantReply": reply})
	if err != nil {
		return PromptSuggestionReply{Error: promptErrorString(err.Error())}
	}
	context := map[string]any{
		"systemPrompt": system,
		"messages": []any{map[string]any{
			"role": "user", "content": string(body), "timestamp": NowMillis(),
		}},
	}
	options := map[string]any{"maxTokens": 160, "reasoning": "minimal"}
	if input.Signal != nil {
		options["signal"] = input.Signal
	}
	stream, err := input.Stream(input.Model, context, options)
	if err != nil {
		return PromptSuggestionReply{Error: promptErrorString(err.Error())}
	}
	message := stream.Result()
	raw := promptSuggestionTextFromMessage(message)
	stop := mapString(message, "stopReason")
	var stopPtr *string
	if stop != "" {
		stopPtr = &stop
	}
	reported := ""
	if text, ok := message["errorMessage"].(string); ok {
		reported = text
	}
	var errorPtr *string
	if reported != "" {
		errorPtr = &reported
	}
	text := ""
	if stop == "stop" {
		text = normalizeSuggestion(raw)
	}
	return PromptSuggestionReply{Text: text, Raw: raw, StopReason: stopPtr, Error: errorPtr}
}

func promptErrorString(message string) *string {
	return &message
}
