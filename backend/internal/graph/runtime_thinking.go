package graph

// Thinking strengths a configured model accepts.
//
// The per-model subset comes from the catalog (ThinkingLevelMapFor), and the
// final answer is the SDK's own judgement applied to the same model object the
// transport uses. The Pi SDK is not linked; getSupportedThinkingLevels and
// clampThinkingLevel are the @earendil-works/pi-ai@0.86.1 algorithms, and
// ControlledThinkingFields is the same SDK's wire rule for the way one provider
// is asked for a strength.

var extendedThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

func getSupportedThinkingLevels(reasoning bool, thinkingLevelMap map[string]*string) []string {
	if !reasoning {
		return []string{"off"}
	}
	out := []string{}
	for _, level := range extendedThinkingLevels {
		var mapped *string
		ok := false
		if thinkingLevelMap != nil {
			mapped, ok = thinkingLevelMap[level]
		}
		if ok && mapped == nil {
			continue
		}
		if level == "xhigh" || level == "max" {
			if !ok {
				continue
			}
		}
		out = append(out, level)
	}
	return out
}

func clampThinkingLevel(reasoning bool, thinkingLevelMap map[string]*string, level string) string {
	available := getSupportedThinkingLevels(reasoning, thinkingLevelMap)
	for _, candidate := range available {
		if candidate == level {
			return level
		}
	}
	requestedIndex := -1
	for i, candidate := range extendedThinkingLevels {
		if candidate == level {
			requestedIndex = i
			break
		}
	}
	if requestedIndex == -1 {
		if len(available) == 0 {
			return "off"
		}
		return available[0]
	}
	for i := requestedIndex; i < len(extendedThinkingLevels); i++ {
		for _, candidate := range available {
			if candidate == extendedThinkingLevels[i] {
				return candidate
			}
		}
	}
	for i := requestedIndex - 1; i >= 0; i-- {
		for _, candidate := range available {
			if candidate == extendedThinkingLevels[i] {
				return candidate
			}
		}
	}
	if len(available) == 0 {
		return "off"
	}
	return available[0]
}

// ControlledThinkingLevelMap reads the level map one model carries.
//
// The map is the model's own answer to "which effort means what here": a denied
// level is a null and an allowed level is the value the provider expects for it.
func ControlledThinkingLevelMap(model map[string]any) map[string]*string {
	raw, ok := model["thinkingLevelMap"].(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]*string{}
	for level, value := range raw {
		if value == nil {
			out[level] = nil
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		copied := text
		out[level] = &copied
	}
	return out
}

// controlledClampedLevel is the strength one request asks for.
//
// The stored strength is clamped to what the model accepts, and a strength of
// "off" is not a strength at all: it is dropped on the way out, exactly as the
// worker drops it, so a model that runs no thinking is asked for no thinking.
func controlledClampedLevel(model map[string]any, options map[string]any) string {
	requested, _ := options["reasoning"].(string)
	if requested == "" || requested == "off" {
		return "off"
	}
	reasoning := true
	if value, ok := model["reasoning"].(bool); ok {
		reasoning = value
	}
	if !reasoning {
		return "off"
	}
	return clampThinkingLevel(reasoning, ControlledThinkingLevelMap(model), requested)
}

// ControlledMaxTokens is the ceiling one request carries.
//
// The caller's cap wins over the model's own limit: a call that asks for a
// short answer must not be handed the whole budget.
func ControlledMaxTokens(model map[string]any, options map[string]any) int64 {
	if value, ok := controlledSafeCount(options["maxTokens"]); ok && value > 0 {
		return value
	}
	if value, ok := controlledSafeCount(model["maxTokens"]); ok && value > 0 {
		return value
	}
	return 0
}

// controlledThinkingBudget is the token budget one strength asks for.
//
// These are the SDK's budgets, and the two strongest strengths share the
// strongest budget: a provider that names no budget of its own gets the one
// this table holds.
func controlledThinkingBudget(level string) (int64, bool) {
	switch level {
	case "minimal":
		return 1024, true
	case "low":
		return 2048, true
	case "medium":
		return 8192, true
	case "high", "xhigh", "max":
		return 16384, true
	}
	return 0, false
}

// MIN_ANSWER_TOKENS is the room the answer always keeps under the ceiling.
const MIN_ANSWER_TOKENS = 1024

// ControlledAnthropicThinking is the thinking part of one Anthropic request.
//
// Anthropic is asked for a budget of tokens rather than for a named strength:
// the strength names the budget, the ceiling grows by the budget (but never
// past the model's own limit), and the answer keeps a share of the ceiling for
// itself. These are the SDK's rules.
func ControlledAnthropicThinking(model map[string]any, options map[string]any) (int64, map[string]any) {
	base := ControlledMaxTokens(model, options)
	modelMax, _ := controlledSafeCount(model["maxTokens"])
	level := controlledClampedLevel(model, options)
	budget, ok := controlledThinkingBudget(level)
	if !ok {
		return base, map[string]any{}
	}
	ceiling := base + budget
	if modelMax > 0 && ceiling > modelMax {
		ceiling = modelMax
	}
	answerRoom := ceiling - MIN_ANSWER_TOKENS
	if answerRoom < 0 {
		answerRoom = 0
	}
	if ceiling <= budget && budget > answerRoom {
		budget = answerRoom
	}
	tokens := budget
	if tokens > answerRoom {
		tokens = answerRoom
	}
	if tokens == 0 {
		tokens = MIN_ANSWER_TOKENS
	}
	return ceiling, map[string]any{
		"thinking": map[string]any{"type": "enabled", "budget_tokens": tokens, "display": "summarized"},
	}
}

// ControlledThinkingFields is the thinking part of one provider request.
//
// The SDK gives every provider its own way of asking for a strength, and a
// provider asked in the wrong way refuses the whole request. These are the
// SDK's rules: the same clamp, the same fields, and no field at all for a model
// that runs no thinking.
func ControlledThinkingFields(model map[string]any, options map[string]any) map[string]any {
	out := map[string]any{}
	level := controlledClampedLevel(model, options)
	if level == "off" {
		return out
	}
	levels := ControlledThinkingLevelMap(model)
	compat := controlledCompatFor(model)
	switch compat.thinkingFormat {
	case "zai":
		out["thinking"] = map[string]any{"type": "enabled", "clear_thinking": false}
		if compat.supportsReasoningEffort {
			if effort, ok := controlledMappedEffort(levels, level); ok {
				out["reasoning_effort"] = effort
			}
		}
	case "deepseek":
		out["thinking"] = map[string]any{"type": "enabled"}
		if compat.supportsReasoningEffort {
			out["reasoning_effort"] = controlledEffortValue(levels, level)
		}
	case "together":
		out["reasoning"] = map[string]any{"enabled": true}
	case "ant-ling":
		if effort, ok := controlledMappedEffort(levels, level); ok {
			out["reasoning"] = map[string]any{"effort": effort}
		}
	case "openrouter":
		out["reasoning"] = map[string]any{"effort": controlledEffortValue(levels, level)}
	default:
		if compat.supportsReasoningEffort {
			out["reasoning_effort"] = controlledEffortValue(levels, level)
		}
	}
	return out
}

// controlledEffortValue is the effort the provider expects for one level.
//
// The model's own level map names it when the catalog says so; otherwise the
// level itself is the value.
func controlledEffortValue(levels map[string]*string, level string) string {
	if effort, ok := levels[level]; ok && effort != nil {
		return *effort
	}
	return level
}

// controlledMappedEffort is the effort the model itself names for one level.
//
// A level the model denies has no name to send, and a request that carries
// none is the honest one.
func controlledMappedEffort(levels map[string]*string, level string) (string, bool) {
	effort, ok := levels[level]
	if !ok || effort == nil {
		return "", false
	}
	return *effort, true
}

// ThinkingOptionsFor lists the strengths this model accepts, in Pi's canonical order.
func ThinkingOptionsFor(entry ModelEntry) []ModelThinkingOption {
	labels := map[string]string{}
	if meta := ModelMetadataFor(entry); meta != nil {
		for _, option := range meta.ThinkingOptions {
			labels[string(option.Level)] = option.Label
		}
	}
	model := ToPiModel(entry)
	levels := getSupportedThinkingLevels(model.Reasoning, model.ThinkingLevelMap)
	out := make([]ModelThinkingOption, 0, len(levels))
	for _, level := range levels {
		label := labels[level]
		if label == "" {
			label = level
		}
		out = append(out, ModelThinkingOption{Level: ModelThinkingLevel(level), Label: label})
	}
	return out
}

// EffectiveThinkingLevel is the level a model will actually run at.
func EffectiveThinkingLevel(entry ModelEntry, requested *string) ModelThinkingLevel {
	wanted := "off"
	switch {
	case requested != nil:
		wanted = *requested
	case entry.DefaultThinkingLevel != "":
		wanted = string(entry.DefaultThinkingLevel)
	default:
		options := ThinkingOptionsFor(entry)
		levels := make([]struct{ Level string }, len(options))
		for i, option := range options {
			levels[i].Level = string(option.Level)
		}
		if fallback := DefaultThinkingLevelFor(levels); fallback != "" {
			wanted = fallback
		}
	}
	model := ToPiModel(entry)
	return ModelThinkingLevel(clampThinkingLevel(model.Reasoning, model.ThinkingLevelMap, wanted))
}
