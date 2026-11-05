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
		Description: "Search this conversation's whole durable transcript (compaction and reset keep it). " +
			"No arguments lists recent entries; query finds text anywhere in the conversation, however far back; " +
			"entryId reads one entry; before continues further back from an id a previous search returned.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":   map[string]any{"type": "string", "description": "Keyword or phrase to find, case-insensitive."},
				"entryId": map[string]any{"type": "integer", "description": "Read one entry in full by its id."},
				"limit":   map[string]any{"type": "integer", "description": "Maximum entries to return; default 5, at most 20."},
				"before":  map[string]any{"type": "integer", "description": "Only entries older than this id, to continue a walk further back."},
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
//
// It walks the whole transcript, newest first, one page at a time. It used to
// read the newest 2000 entries and stop: compaction promises that nothing is
// lost because this tool can reach the transcript, and a keyword from before
// that window answered "no entry matches" (measured 2026-11-05 on a 16,041
// entry conversation - 87% of it was unreachable). The walk is bounded so one
// search cannot page forever; when the bound is what stopped it, the answer
// says so and hands back the cursor to continue from.
func (session *Session) searchHistory(ctx context.Context, args map[string]any) (string, error) {
	const pageLimit = 2000
	const scanBudget = 40000
	query := strings.TrimSpace(valueString(args["query"]))
	entryId := valueInt64(args["entryId"])
	limit := int(valueInt64(args["limit"]))
	if limit <= 0 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}
	before := valueInt64(args["before"])
	base := durable.EntryQuery{ConversationId: session.conversation.Id()}
	if before > 0 {
		bound := durable.EntryId(before)
		base.MaxEntryId = &bound
	}
	matches := []string{}
	scanned := 0
	oldest := 0
	var cursor durable.Cursor
	budgetHit := false
	for {
		page, err := session.conversation.Entries(ctx, base, pageLimit, cursor)
		if err != nil {
			return "", fmt.Errorf("pig kernel: read the transcript: %w", err)
		}
		for _, entry := range page.Items {
			scanned++
			oldest = int(entry.Id)
			role, text := entryText(entry)
			if entryId > 0 {
				if int64(entry.Id) == entryId {
					return fmt.Sprintf("entry #%d %s (%s)\n\n%s", entry.Id, entry.Kind, role, truncateRunes(text, 20000)), nil
				}
				continue
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
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
		if len(matches) >= limit || entryId > 0 || page.Next == nil {
			break
		}
		if scanned >= scanBudget {
			budgetHit = true
			break
		}
		cursor = *page.Next
	}
	if entryId > 0 {
		return fmt.Sprintf("entry #%d is not in this conversation (searched back %d entries); search by keyword instead", entryId, scanned), nil
	}
	if len(matches) == 0 {
		if query == "" {
			return fmt.Sprintf("conversation %d has no readable entries", session.conversation.Id()), nil
		}
		reply := fmt.Sprintf("no entry in the %d entries searched of conversation %d matches %q", scanned, session.conversation.Id(), query)
		if budgetHit {
			reply += fmt.Sprintf("; the walk stopped at its %d-entry bound, so older entries were not examined - continue with before=%d", scanBudget, oldest)
		}
		return reply, nil
	}
	header := fmt.Sprintf("conversation %d, searched back %d entries", session.conversation.Id(), scanned)
	if query != "" {
		header += fmt.Sprintf(", query %q", query)
	}
	if budgetHit {
		header += fmt.Sprintf(" (stopped at the %d-entry bound; continue with before=%d)", scanBudget, oldest)
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
