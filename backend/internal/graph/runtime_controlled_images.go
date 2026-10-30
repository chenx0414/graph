package graph

// Images in the transcript.
//
// A transcript carries an image as its own content part: `{type: "image",
// data, mimeType}`. Flattening that part to text leaves an empty string, so the
// model reads a tool that answered with a picture as a tool that answered with
// nothing. Every wire format below keeps the part as an image, in the shape the
// provider expects, and keeps a content value with no image exactly as it was.

// controlledImageParts are the images one content value carries, in order.
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

// controlledOpenAIContent renders one content value the way an OpenAI message
// carries it: the text when it holds no image, the parts array when it does.
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

// controlledAnthropicContent renders one content value as Anthropic content
// blocks. A value with no image is the text it carries, exactly as before.
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
