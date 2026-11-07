package graph

var mappedOnly = map[string]bool{"xhigh": true, "max": true}

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

func ThinkingLevelMapFor(entry ModelEntry, metadata ...*ModelMetadata) ThinkingLevelMapView {
	var meta *ModelMetadata
	if len(metadata) == 0 {
		meta = ModelMetadataFor(entry)
	} else {
		meta = metadata[0]
	}
	options := thinkingOptionLabels(meta)
	out := ThinkingLevelMapView{}
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
