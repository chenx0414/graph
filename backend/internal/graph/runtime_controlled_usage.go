package graph

import (
	"io"
	"net/http"
	"strings"

	"encoding/json"
)

// controlledZeroUsage is the settlement of a send that produced no tokens.
var controlledZeroUsage = TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0, UsageSource: stringPointer(string(UsageAuthoritative))}

// controlledRetryableTransportCodes are the transport failures that prove nothing was sent.
var controlledRetryableTransportCodes = map[string]bool{
	"ECONNREFUSED":            true,
	"ENOTFOUND":               true,
	"UND_ERR_CONNECT_TIMEOUT": true,
}

// stringPointer reads one text as an optional value.
func stringPointer(value string) *string {
	return &value
}

// stringPointerValue reads an optional value as one text.
func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// ControlledProviderUsage parses the usage one provider reported.
func ControlledProviderUsage(value any, api ModelApi) *TokenUsage {
	if api == "anthropic-messages" {
		return controlledAnthropicUsage(value)
	}
	return controlledOpenAIUsage(value)
}

// controlledOpenAIUsage parses one OpenAI usage object.
func controlledOpenAIUsage(value any) *TokenUsage {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input, inputOK := controlledSafeCount(raw["prompt_tokens"])
	output, outputOK := controlledSafeCount(raw["completion_tokens"])
	cache := int64(0)
	if details, ok := raw["prompt_tokens_details"].(map[string]any); ok {
		if count, ok := controlledSafeCount(details["cached_tokens"]); ok {
			cache = count
		}
	}
	if cache == 0 {
		if count, ok := controlledSafeCount(raw["prompt_cache_hit_tokens"]); ok {
			cache = count
		} else if count, ok := controlledSafeCount(raw["cached_tokens"]); ok {
			cache = count
		}
	}
	if !inputOK || !outputOK {
		return nil
	}
	if cache > input {
		return nil
	}
	if total, present := raw["total_tokens"]; present && total != nil {
		count, ok := controlledSafeCount(total)
		if !ok || count != input+output {
			return nil
		}
	}
	return &TokenUsage{Input: input - cache, Output: output, CacheRead: cache, CacheWrite: 0, UsageSource: stringPointer(string(UsageAuthoritative))}
}

// controlledAnthropicUsage parses one Anthropic usage object.
func controlledAnthropicUsage(value any) *TokenUsage {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input, inputOK := controlledSafeCount(raw["input_tokens"])
	output, outputOK := controlledSafeCount(raw["output_tokens"])
	cacheReadValue := raw["cache_read_input_tokens"]
	if cacheReadValue == nil {
		cacheReadValue = float64(0)
	}
	cacheRead, cacheReadOK := controlledSafeCount(cacheReadValue)
	cacheWriteValue := raw["cache_creation_input_tokens"]
	if cacheWriteValue == nil {
		cacheWriteValue = float64(0)
	}
	cacheWrite, cacheWriteOK := controlledSafeCount(cacheWriteValue)
	if !inputOK || !outputOK || !cacheReadOK || !cacheWriteOK {
		return nil
	}
	return &TokenUsage{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite, UsageSource: stringPointer(string(UsageAuthoritative))}
}

// controlledSafeCount reads one nonnegative integer count.
func controlledSafeCount(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed < 0 || typed != float64(int64(typed)) || !jsSafeInteger(typed) {
			return 0, false
		}
		return int64(typed), true
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case json.Number:
		number, err := typed.Int64()
		if err != nil || number < 0 {
			return 0, false
		}
		return number, true
	}
	return 0, false
}

// ControlledReadUsage reads the usage one provider response carries.
func ControlledReadUsage(response *http.Response, api ModelApi) *TokenUsage {
	// A bounded clone observes raw evidence; an SDK's zero-filled error is not evidence.
	if response == nil || response.Body == nil {
		return nil
	}
	contentType := response.Header.Get("content-type")
	body, err := io.ReadAll(io.LimitReader(response.Body, 8_000_001))
	response.Body.Close()
	if err != nil {
		return nil
	}
	if len(body) > 8_000_000 {
		return nil
	}
	if strings.Contains(contentType, "application/json") {
		var decoded map[string]any
		if err := json.Unmarshal(body, &decoded); err != nil {
			return nil
		}
		return ControlledProviderUsage(decoded["usage"], api)
	}
	evidence := controlledUsageEvidence{}
	for _, line := range strings.Split(string(body), "\n") {
		if evidence.feed(line, api) {
			return evidence.result(api)
		}
	}
	return evidence.result(api)
}

type controlledUsageEvidence struct {
	usage    *TokenUsage
	complete bool
	terminal bool
}

func (evidence *controlledUsageEvidence) result(api ModelApi) *TokenUsage {
	if api == "anthropic-messages" && (!evidence.complete || !evidence.terminal) {
		return nil
	}
	return evidence.usage
}

func (evidence *controlledUsageEvidence) feed(line string, api ModelApi) bool {
	if !strings.HasPrefix(line, "data:") {
		return false
	}
	payload := strings.TrimSpace(line[5:])
	if payload == "" {
		return false
	}
	if api == "openai-completions" && payload == "[DONE]" {
		evidence.terminal = true
		return true
	}
	var event map[string]any
	if json.Unmarshal([]byte(payload), &event) != nil {
		return false
	}
	if api == "anthropic-messages" {
		switch rsiText(event["type"]) {
		case "message_start":
			evidence.usage = controlledAnthropicUsage(asMap(event["message"])["usage"])
			evidence.complete = false
		case "message_delta":
			if evidence.usage != nil {
				base := evidence.usage
				delta := map[string]any{"input_tokens": float64(base.Input), "cache_read_input_tokens": float64(base.CacheRead), "cache_creation_input_tokens": float64(base.CacheWrite)}
				for key, value := range asMap(event["usage"]) {
					delta[key] = value
				}
				evidence.usage = controlledAnthropicUsage(delta)
				evidence.complete = evidence.usage != nil
			}
		case "message_stop":
			evidence.terminal = true
			return true
		}
	} else if event["usage"] != nil {
		evidence.usage = controlledOpenAIUsage(event["usage"])
	}
	return false
}
