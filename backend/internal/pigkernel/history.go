package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode/utf16"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
)

// The kernel keeps two things beside the live context: a summary written when
// the context is compacted, and the durable transcript itself. A compaction
// replaces the context with the summary; a reset replaces it with a pointer.
// Either way the entries stay readable, and history_search is how the next
// turn reaches them: the model asks for what it needs instead of the daemon
// deciding in advance what must survive.

const (
	// estimateCharsPerToken is pi-ai's chars/token estimate, the one the
	// kernel's own threshold compaction uses.
	estimateCharsPerToken = 3.5
	// estimateImageChars is pi-ai's allowance for one image, in characters.
	estimateImageChars = 4800
)

// estimateContextTokens estimates the request the next turn will send.
//
// The last measured assistant message is the anchor: its usage is what the
// provider billed for the whole prefix up to it, so only the messages after it
// are estimated. JSON bytes are not a token count - escaped HTML and tool
// results inflated the old estimate by 30-170% and reset sessions that still
// fit. This mirrors the estimate the kernel's own threshold compaction uses.
func estimateContextTokens(messages []ai.Message) int {
	anchor := 0.0
	start := 0
	for index := len(messages) - 1; index >= 0; index-- {
		assistant, ok := messages[index].(ai.AssistantMessage)
		if !ok {
			continue
		}
		measured := assistant.Usage.TotalTokens
		if measured <= 0 {
			measured = assistant.Usage.Input + assistant.Usage.Output + assistant.Usage.CacheRead + assistant.Usage.CacheWrite
		}
		if measured <= 0 {
			continue
		}
		anchor = float64(measured)
		start = index + 1
		break
	}
	total := anchor
	for _, message := range messages[start:] {
		total += estimateMessageTokens(message)
	}
	return int(math.Ceil(total))
}

// estimateTextTokens estimates one pending text the way pi-ai does.
func estimateTextTokens(text string) float64 {
	if text == "" {
		return 0
	}
	return math.Ceil(float64(utf16Units(text)) / estimateCharsPerToken)
}

// estimateMessageTokens estimates one message the way pi-ai does.
func estimateMessageTokens(message ai.Message) float64 {
	chars := 0
	switch value := message.(type) {
	case ai.UserMessage:
		chars += userContentChars(value.Content)
	case ai.AssistantMessage:
		for _, block := range value.Content {
			switch content := block.(type) {
			case ai.TextContent:
				chars += utf16Units(content.Text)
			case ai.ThinkingContent:
				chars += utf16Units(content.Thinking)
			case ai.ToolCall:
				chars += utf16Units(content.Name)
				if encoded, err := json.Marshal(content.Arguments); err == nil {
					chars += utf16Units(string(encoded))
				}
			}
		}
	case ai.ToolResultMessage:
		for _, block := range value.Content {
			switch content := block.(type) {
			case ai.TextContent:
				chars += utf16Units(content.Text)
			case ai.ImageContent:
				chars += estimateImageChars
			}
		}
	}
	return math.Ceil(float64(chars) / estimateCharsPerToken)
}

// userContentChars counts a user message's characters.
func userContentChars(content ai.UserContent) int {
	switch value := content.(type) {
	case ai.UserText:
		return utf16Units(string(value))
	case ai.UserContentBlocks:
		chars := 0
		for _, block := range value {
			switch content := block.(type) {
			case ai.TextContent:
				chars += utf16Units(content.Text)
			case ai.ImageContent:
				chars += estimateImageChars
			}
		}
		return chars
	}
	return 0
}

// utf16Units is JavaScript's string length: the unit pi-ai's estimate uses.
func utf16Units(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// historyToolName is the tool that reads the durable transcript.
const historyToolName = "history_search"

// historyTool is the session-bound handler of history_search. The tool schema
// is registered with the kernel before the session exists, so the handler
// resolves the session on its first call.
type historyTool struct {
	session *Session
}

// spec is the tool the model sees.
func (tool *historyTool) spec() ToolSpec {
	return ToolSpec{
		Name: historyToolName,
		Description: "Search this conversation's durable transcript (compaction and reset keep it). " +
			"No arguments lists recent entries; query finds text; entryId reads one entry.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":   map[string]any{"type": "string", "description": "Keyword or phrase to find, case-insensitive."},
				"entryId": map[string]any{"type": "integer", "description": "Read one entry in full by its id."},
				"limit":   map[string]any{"type": "integer", "description": "Maximum entries to return; default 5, at most 20."},
			},
		},
		Execute: func(ctx context.Context, args map[string]any) (string, error) {
			if tool.session == nil {
				return "", fmt.Errorf("pig kernel: the transcript is not open yet")
			}
			return tool.session.searchHistory(ctx, args)
		},
	}
}

// searchHistory reads the durable transcript of this conversation.
func (session *Session) searchHistory(ctx context.Context, args map[string]any) (string, error) {
	const scanLimit = 2000
	page, err := session.conversation.Entries(ctx, durable.EntryQuery{ConversationId: session.conversation.Id()}, scanLimit, nil)
	if err != nil {
		return "", fmt.Errorf("pig kernel: read the transcript: %w", err)
	}
	query := strings.TrimSpace(valueString(args["query"]))
	entryId := valueInt64(args["entryId"])
	limit := int(valueInt64(args["limit"]))
	if limit <= 0 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}
	if entryId > 0 {
		for _, entry := range page.Items {
			if int64(entry.Id) != entryId {
				continue
			}
			role, text := entryText(entry)
			return fmt.Sprintf("entry #%d %s (%s)\n\n%s", entry.Id, entry.Kind, role, truncateRunes(text, 20000)), nil
		}
		return fmt.Sprintf("entry #%d is not among the last %d entries; search by keyword instead", entryId, scanLimit), nil
	}
	matches := []string{}
	scanned := 0
	for _, entry := range page.Items {
		role, text := entryText(entry)
		if strings.TrimSpace(text) == "" {
			continue
		}
		scanned++
		if query != "" && !strings.Contains(strings.ToLower(text), strings.ToLower(query)) {
			continue
		}
		excerpt := truncateRunes(text, 300)
		if query != "" {
			excerpt = excerptAround(text, query, 300)
		}
		matches = append(matches, fmt.Sprintf("#%d %s (%s): %s", entry.Id, entry.Kind, role, excerpt))
		if len(matches) >= limit {
			break
		}
	}
	if len(matches) == 0 {
		if query == "" {
			return fmt.Sprintf("conversation %d has no readable entries in the last %d", session.conversation.Id(), scanLimit), nil
		}
		return fmt.Sprintf("no entry in the last %d entries of conversation %d matches %q", scanLimit, session.conversation.Id(), query), nil
	}
	header := fmt.Sprintf("conversation %d, %d of the last %d entries", session.conversation.Id(), scanned, scanLimit)
	if query != "" {
		header += fmt.Sprintf(", query %q", query)
	}
	return header + "\n\n" + truncateRunes(strings.Join(matches, "\n"), 16000), nil
}

// entryText is the entry's readable text and the roles that contributed it.
func entryText(entry durable.EntryRecord) (string, string) {
	parts := []string{}
	roles := []string{}
	seen := map[string]bool{}
	for _, message := range entry.Model {
		role, text := messageText(message)
		if strings.TrimSpace(text) == "" {
			continue
		}
		parts = append(parts, text)
		if !seen[role] {
			seen[role] = true
			roles = append(roles, role)
		}
	}
	return strings.Join(roles, ","), strings.Join(parts, "\n")
}

// messageText is one message's role and text, with tool calls named so a
// search finds the command that produced a result.
func messageText(message ai.Message) (string, string) {
	switch value := message.(type) {
	case ai.UserMessage:
		return "user", userText(value.Content)
	case ai.AssistantMessage:
		parts := []string{}
		for _, block := range value.Content {
			switch content := block.(type) {
			case ai.TextContent:
				if strings.TrimSpace(content.Text) != "" {
					parts = append(parts, content.Text)
				}
			case ai.ToolCall:
				args, err := json.Marshal(content.Arguments)
				if err != nil {
					args = []byte("{}")
				}
				parts = append(parts, fmt.Sprintf("[tool %s %s]", content.Name, string(args)))
			}
		}
		return "assistant", strings.Join(parts, "\n")
	case ai.ToolResultMessage:
		parts := []string{}
		for _, block := range value.Content {
			if content, ok := block.(ai.TextContent); ok {
				parts = append(parts, content.Text)
			}
		}
		return "tool", strings.Join(parts, "\n")
	}
	return "", ""
}

// userText is a user message's text without its images.
func userText(content ai.UserContent) string {
	switch value := content.(type) {
	case ai.UserText:
		return string(value)
	case ai.UserContentBlocks:
		parts := []string{}
		for _, block := range value {
			if content, ok := block.(ai.TextContent); ok {
				parts = append(parts, content.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// excerptAround returns the text around the first match of query.
func excerptAround(text, query string, radius int) string {
	lower := strings.ToLower(text)
	at := strings.Index(lower, strings.ToLower(query))
	if at < 0 {
		return truncateRunes(text, radius*2)
	}
	runes := []rune(text)
	byteToRune := func(index int) int { return len([]rune(text[:index])) }
	center := byteToRune(at)
	start := center - radius
	if start < 0 {
		start = 0
	}
	end := center + radius
	if end > len(runes) {
		end = len(runes)
	}
	prefix := ""
	if start > 0 {
		prefix = "…"
	}
	suffix := ""
	if end < len(runes) {
		suffix = "…"
	}
	return prefix + string(runes[start:end]) + suffix
}

// truncateRunes shortens text to at most limit runes.
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

// valueString reads a string argument.
func valueString(value any) string {
	text, _ := value.(string)
	return text
}

// valueInt64 reads a number argument; the tool arguments arrive as JSON.
func valueInt64(value any) int64 {
	switch number := value.(type) {
	case float64:
		return int64(number)
	case int64:
		return number
	case int:
		return int64(number)
	case json.Number:
		parsed, _ := number.Int64()
		return parsed
	}
	return 0
}

// toolRegistered reports whether the daemon already declared a tool with this
// name, so the kernel's own reader never shadows a daemon tool.
func toolRegistered(tools []ToolSpec, name string) bool {
	for _, tool := range tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}
