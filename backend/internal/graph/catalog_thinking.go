package graph

// mappedOnly are levels the SDK refuses to invent: it accepts xhigh/max only through an
// explicit mapping, so a model that does not name them does not offer them.
var mappedOnly = map[string]bool{"xhigh": true, "max": true}

// ThinkingLevelMapView: a nil pointer denies a level, a string is the value the provider expects.
type ThinkingLevelMapView map[string]*string

func ModelMetadataFor(entry ModelEntry) *ModelMetadata {
	provider, id := modelEntryIdentity(entry)
	found := LookupModelMetadata(provider, id)
	return found
}

func modelEntryIdentity(entry ModelEntry) (provider, id string) {
	m := asMap(entry)
	provider = mapString(m, "provider", "Provider")
	id = mapString(m, "id", "ID")
	if mapHas(m, "modelId", "ModelID", "modelID") {
		if alt, ok := m["modelId"].(string); ok {
			id = alt
		} else if alt, ok := m["ModelID"].(string); ok {
			id = alt
		} else if alt, ok := m["modelID"].(string); ok {
			id = alt
		}
	}
	return provider, id
}

// ThinkingLevelMapFor builds Model.thinkingLevelMap. Pass no metadata to look it up.
// Pass an explicit nil pointer to mean the snapshot had no metadata (null, not undefined).
func ThinkingLevelMapFor(entry ModelEntry, metadata ...*ModelMetadata) ThinkingLevelMapView {
	var meta *ModelMetadata
	if len(metadata) == 0 {
		meta = ModelMetadataFor(entry)
	} else {
		meta = metadata[0]
	}
	options := thinkingOptionLabels(meta)
	out := ThinkingLevelMapView{}
	// off is denied outright: every model is treated as thinking-capable and a
	// strength is always chosen. This only affects which levels the SDK reports.
	out["off"] = nil
	for _, level := range MODEL_THINKING_LEVELS {
		name := string(level)
		if name == "off" {
			continue
		}
		if label, ok := options[name]; ok {
			copy := label
			out[name] = &copy
			continue
		}
		// The snapshot names no discrete effort for this model (only a toggle or a
		// token budget): keep Pi's own default levels, and deny the two levels the
		// SDK will not invent on its own.
		if len(options) == 0 && !mappedOnly[name] {
			copy := name
			out[name] = &copy
			continue
		}
		out[name] = nil
	}
	return out
}

func thinkingOptionLabels(metadata *ModelMetadata) map[string]string {
	if metadata == nil {
		return nil
	}
	m := asMap(metadata)
	raw, ok := m["thinkingOptions"]
	if !ok {
		raw = m["ThinkingOptions"]
	}
	list, _ := raw.([]any)
	out := map[string]string{}
	for _, item := range list {
		row, _ := item.(map[string]any)
		level := mapString(row, "level", "Level")
		label := mapString(row, "label", "Label")
		if level != "" {
			out[level] = label
		}
	}
	return out
}
