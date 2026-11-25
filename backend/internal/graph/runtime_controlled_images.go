package graph

func controlledImageParts(value any) []map[string]any {
	parts := []map[string]any{}
	visit := func(item any) {
		block, ok := item.(map[string]any)
		if !ok {
			return
		}
		if kind, _ := block["type"].(string); kind != "image" {
			return
		}
		data, _ := block["data"].(string)
		if data == "" {
			return
		}
		mimeType, _ := block["mimeType"].(string)
		if mimeType == "" {
			mimeType = "image/png"
		}
		parts = append(parts, map[string]any{"data": data, "mimeType": mimeType})
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			visit(item)
		}
	case map[string]any:
		visit(typed)
	}
	return parts
}

func controlledOpenAIContent(value any) any {
	images := controlledImageParts(value)
	if len(images) == 0 {
		return ControlledTextFromContent(value)
	}
	parts := []any{}
	if text := ControlledTextFromContent(value); text != "" {
		parts = append(parts, map[string]any{"type": "text", "text": text})
	}
	for _, image := range images {
		parts = append(parts, map[string]any{
			"type": "image_url",
			"image_url": map[string]any{
				"url": "data:" + image["mimeType"].(string) + ";base64," + image["data"].(string),
			},
		})
	}
	return parts
}

func controlledAnthropicContent(value any) any {
	images := controlledImageParts(value)
	if len(images) == 0 {
		return ControlledTextFromContent(value)
	}
	blocks := []any{}
	if text := ControlledTextFromContent(value); text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	for _, image := range images {
		blocks = append(blocks, map[string]any{
			"type": "image",
			"source": map[string]any{
				"type": "base64", "media_type": image["mimeType"].(string), "data": image["data"].(string),
			},
		})
	}
	return blocks
}
