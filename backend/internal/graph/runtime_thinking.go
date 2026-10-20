package graph

// Thinking strengths a configured model accepts.
//
// The per-model subset comes from the catalog (ThinkingLevelMapFor), and the
// final answer is the SDK's own judgement applied to the same model object the
// transport uses. The Pi SDK is not linked; getSupportedThinkingLevels and
// clampThinkingLevel are the @earendil-works/pi-ai@0.86.1 algorithms.

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
