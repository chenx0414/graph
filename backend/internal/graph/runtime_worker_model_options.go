package graph

// WorkerModelOptions is the generation settings that cross IPC.
// Credentials, headers, callbacks and cancellation stay with the host.
type WorkerModelOptions struct {
	Reasoning       *string          `json:"reasoning,omitempty"`
	SessionId       *string          `json:"sessionId,omitempty"`
	Temperature     *float64         `json:"temperature,omitempty"`
	MaxTokens       *int64           `json:"maxTokens,omitempty"`
	ThinkingBudgets *ThinkingBudgets `json:"thinkingBudgets,omitempty"`
}

// ThinkingBudgets is the per-level token budget carried to the worker.
type ThinkingBudgets struct {
	Minimal *int64 `json:"minimal,omitempty"`
	Low     *int64 `json:"low,omitempty"`
	Medium  *int64 `json:"medium,omitempty"`
	High    *int64 `json:"high,omitempty"`
}

var workerReasoningLevels = map[string]bool{
	"minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

// WorkerModelOptionsOf keeps only the generation settings a worker may see.
func WorkerModelOptionsOf(value any) WorkerModelOptions {
	input, ok := value.(map[string]any)
	if !ok || value == nil {
		return WorkerModelOptions{}
	}
	var result WorkerModelOptions
	if reasoning, ok := input["reasoning"].(string); ok && workerReasoningLevels[reasoning] {
		result.Reasoning = &reasoning
	}
	if session, ok := input["sessionId"].(string); ok && utf16Len(session) <= 1024 {
		result.SessionId = &session
	}
	if temperature, ok := asFloat(input["temperature"]); ok && temperature == temperature && temperature < 1e308 && temperature > -1e308 {
		result.Temperature = &temperature
	}
	if maxTokens, ok := asFloat(input["maxTokens"]); ok && jsSafeInteger(maxTokens) && maxTokens > 0 {
		n := int64(maxTokens)
		result.MaxTokens = &n
	}
	if budgets, ok := input["thinkingBudgets"].(map[string]any); ok {
		parsed := ThinkingBudgets{}
		count := 0
		for _, level := range []string{"minimal", "low", "medium", "high"} {
			budget, ok := asFloat(budgets[level])
			if !ok || !jsSafeInteger(budget) || budget < 0 {
				continue
			}
			n := int64(budget)
			count++
			switch level {
			case "minimal":
				parsed.Minimal = &n
			case "low":
				parsed.Low = &n
			case "medium":
				parsed.Medium = &n
			case "high":
				parsed.High = &n
			}
		}
		if count > 0 {
			result.ThinkingBudgets = &parsed
		}
	}
	return result
}
