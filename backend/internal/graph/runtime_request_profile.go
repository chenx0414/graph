package graph

import (
	"encoding/json"
	"fmt"
	"regexp"

	"crypto/sha256"
)

var cacheControlPattern = regexp.MustCompile(`"cache_control"\s*:`)

// ProviderRequestProfile is transport observation without request text or credentials.
type ProviderRequestProfile struct {
	Version               int                       `json:"version"`
	RequestBytes          int                       `json:"requestBytes"`
	Sections              map[string]ProfileSection `json:"sections"`
	ToolResults           []ProfileToolResult       `json:"toolResults"`
	StaticFingerprint     string                    `json:"staticFingerprint"`
	ExplicitCacheControls int                       `json:"explicitCacheControls"`
}

// ProfileSection is one request region's size.
type ProfileSection struct {
	Bytes           int `json:"bytes"`
	EstimatedTokens int `json:"estimatedTokens"`
}

// ProfileToolResult groups tool-result bytes by declared tool name.
type ProfileToolResult struct {
	Tool            *string `json:"tool"`
	ResultViews     int     `json:"resultViews"`
	Bytes           int     `json:"bytes"`
	EstimatedTokens int     `json:"estimatedTokens"`
}

// TODO(port): @earendil-works/pi-ai estimateTextTokens is not in this module. ceil(len/4) is the byte heuristic.
func profileEstimateTokens(text string) int {
	return (len(text) + 3) / 4
}

func profileSize(value any) (int, int) {
	var text string
	if typed, ok := value.(string); ok {
		text = typed
	} else {
		raw, err := json.Marshal(value)
		if err != nil {
			text = ""
		} else {
			text = string(raw)
		}
	}
	return len(text), profileEstimateTokens(text)
}

// ProfileProviderRequest summarizes one provider request body. Non-strings return nil.
func ProfileProviderRequest(body any) *ProviderRequestProfile {
	text, ok := body.(string)
	if !ok {
		return nil
	}
	var request map[string]any
	if err := json.Unmarshal([]byte(text), &request); err != nil {
		panic(err)
	}
	sections := map[string]ProfileSection{}
	add := func(source string, value any, present bool) (int, int, bool) {
		if !present {
			return 0, 0, false
		}
		bytes, tokens := profileSize(value)
		section := sections[source]
		section.Bytes += bytes
		section.EstimatedTokens += tokens
		sections[source] = section
		return bytes, tokens, true
	}
	_, toolsPresent := request["tools"]
	add("tools", request["tools"], toolsPresent)
	_, systemPresent := request["system"]
	add("system", request["system"], systemPresent)
	messages, _ := request["messages"].([]any)
	declared := map[string]bool{}
	if tools, ok := request["tools"].([]any); ok {
		for _, tool := range tools {
			object, _ := tool.(map[string]any)
			name, _ := object["name"].(string)
			if function, ok := object["function"].(map[string]any); ok {
				if functionName, ok := function["name"].(string); ok {
					name = functionName
				}
			}
			if name != "" {
				declared[name] = true
			}
		}
	}
	calls := map[string]*string{}
	type resultKey struct {
		name string
		null bool
	}
	order := []resultKey{}
	grouped := map[resultKey]*ProfileToolResult{}
	remember := func(id, name any) {
		textID, ok := id.(string)
		if !ok {
			return
		}
		var tool *string
		if nameText, ok := name.(string); ok && declared[nameText] {
			tool = &nameText
		}
		calls[textID] = tool
	}
	addResult := func(value, id any) {
		bytes, tokens, ok := add("tool_results", value, true)
		if !ok {
			return
		}
		var tool *string
		if textID, ok := id.(string); ok {
			tool = calls[textID]
		}
		key := resultKey{null: tool == nil}
		if tool != nil {
			key.name = *tool
		}
		row := grouped[key]
		if row == nil {
			row = &ProfileToolResult{Tool: tool}
			grouped[key] = row
			order = append(order, key)
		}
		row.ResultViews++
		row.Bytes += bytes
		row.EstimatedTokens += tokens
	}
	systemMessages := []any{}
	for _, message := range messages {
		item, ok := message.(map[string]any)
		if !ok {
			continue
		}
		role, _ := item["role"].(string)
		if role == "assistant" {
			if toolCalls, ok := item["tool_calls"].([]any); ok {
				for _, call := range toolCalls {
					object, _ := call.(map[string]any)
					var name any
					if function, ok := object["function"].(map[string]any); ok {
						name = function["name"]
					}
					remember(object["id"], name)
				}
			}
			if content, ok := item["content"].([]any); ok {
				for _, block := range content {
					object, _ := block.(map[string]any)
					if object["type"] == "tool_use" {
						remember(object["id"], object["name"])
					}
				}
			}
		}
		if role == "system" || role == "developer" {
			systemMessages = append(systemMessages, message)
			add("system", message, true)
		} else if role == "tool" {
			addResult(message, item["tool_call_id"])
		} else if role == "user" {
			if content, ok := item["content"].([]any); ok {
				for _, block := range content {
					object, _ := block.(map[string]any)
					if object["type"] == "tool_result" {
						addResult(block, object["tool_use_id"])
					} else {
						add("user", block, true)
					}
				}
			} else {
				add("user", message, true)
			}
		} else if role == "assistant" {
			add("assistant_history", message, true)
		} else {
			add("user", message, true)
		}
	}
	prefix := map[string]any{"systemMessages": systemMessages}
	if toolsPresent {
		prefix["tools"] = request["tools"]
	}
	if systemPresent {
		prefix["system"] = request["system"]
	}
	// TODO(port): fingerprint JSON key order follows encoding/json, not JavaScript insertion order.
	raw, err := json.Marshal(prefix)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(raw)
	results := make([]ProfileToolResult, 0, len(order))
	for _, key := range order {
		results = append(results, *grouped[key])
	}
	return &ProviderRequestProfile{
		Version:               1,
		RequestBytes:          len(text),
		Sections:              sections,
		ToolResults:           results,
		StaticFingerprint:     fmt.Sprintf("%x", sum[:]),
		ExplicitCacheControls: len(cacheControlPattern.FindAllString(text, -1)),
	}
}
