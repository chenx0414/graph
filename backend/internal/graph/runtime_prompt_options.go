package graph

// PromptImageOptions is the options object for Pi's AgentSession.prompt.
// Image attachments travel inside Images; a prompt without images passes no options.
type PromptImageOptions struct {
	Images []any `json:"images"`
}

// SdkPromptOptions builds the options object for Pi's AgentSession.prompt(text, options?).
// A prompt without images passes no options at all, exactly like the SDK default.
func SdkPromptOptions(images []any) *PromptImageOptions {
	if len(images) == 0 {
		return nil
	}
	return &PromptImageOptions{Images: images}
}
