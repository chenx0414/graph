package graph

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

func ControlledMaxTokens(model map[string]any, options map[string]any) int64 {
	if value, ok := controlledSafeCount(options["maxTokens"]); ok && value > 0 {
		return value
	}
	if value, ok := controlledSafeCount(model["maxTokens"]); ok && value > 0 {
		return value
	}
	return 0
}

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

const MIN_ANSWER_TOKENS = 1024

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

func controlledEffortValue(levels map[string]*string, level string) string {
	if effort, ok := levels[level]; ok && effort != nil {
		return *effort
	}
	return level
}

func controlledMappedEffort(levels map[string]*string, level string) (string, bool) {
	effort, ok := levels[level]
	if !ok || effort == nil {
		return "", false
	}
	return *effort, true
}
