package graph

import "strings"

// controlledCompat is what one provider accepts.
//
// A provider asked in the wrong way refuses the whole request: the instruction
// role, the way a thinking strength is asked for, and whether the plain effort
// field is understood at all. The SDK detects the provider's answer from its
// name and its base URL, and so does this: one detection, one set of rules.
type controlledCompat struct {
	// supportsDeveloperRole reports whether the provider accepts the `developer`
	// role instead of `system`.
	supportsDeveloperRole bool
	// supportsReasoningEffort reports whether the provider understands the plain
	// `reasoning_effort` field.
	supportsReasoningEffort bool
	// thinkingFormat is the way this provider is asked for a thinking strength.
	thinkingFormat string
}

// controlledCompatFor reads what the provider of one model accepts.
func controlledCompatFor(model map[string]any) controlledCompat {
	provider, _ := model["provider"].(string)
	baseURL, _ := model["baseUrl"].(string)
	modelID, _ := model["id"].(string)
	lowered := strings.ToLower(baseURL)
	isOpenRouter := provider == "openrouter" || strings.Contains(lowered, "openrouter.ai")
	isGrok := provider == "xai" || strings.Contains(lowered, "api.x.ai")
	isZai := provider == "zai" || provider == "zai-coding-cn" ||
		strings.Contains(lowered, "api.z.ai") || strings.Contains(lowered, "open.bigmodel.cn")
	isTogether := provider == "together" || strings.Contains(lowered, "api.together.ai") || strings.Contains(lowered, "api.together.xyz")
	isMoonshot := provider == "moonshotai" || provider == "moonshotai-cn" || strings.Contains(lowered, "api.moonshot.")
	isCloudflareAiGateway := provider == "cloudflare-ai-gateway" || strings.Contains(lowered, "gateway.ai.cloudflare.com")
	isNvidia := provider == "nvidia" || strings.Contains(lowered, "integrate.api.nvidia.com")
	isAntLing := provider == "ant-ling" || strings.Contains(lowered, "api.ant-ling.com")
	isDeepSeek := provider == "deepseek" || strings.Contains(lowered, "deepseek.com")
	nonStandard := isNvidia ||
		provider == "cerebras" || strings.Contains(lowered, "cerebras.ai") ||
		isGrok ||
		isTogether ||
		strings.Contains(lowered, "chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider == "opencode" || strings.Contains(lowered, "opencode.ai") ||
		provider == "cloudflare-workers-ai" || strings.Contains(lowered, "api.cloudflare.com") ||
		isCloudflareAiGateway ||
		isAntLing
	format := "openai"
	switch {
	case isDeepSeek:
		format = "deepseek"
	case isZai:
		format = "zai"
	case isTogether:
		format = "together"
	case isAntLing:
		format = "ant-ling"
	case isOpenRouter:
		format = "openrouter"
	}
	openRouterDeveloper := isOpenRouter &&
		(strings.HasPrefix(modelID, "anthropic/") || strings.HasPrefix(modelID, "openai/"))
	return controlledCompat{
		supportsDeveloperRole:   openRouterDeveloper || (!nonStandard && !isOpenRouter),
		supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		thinkingFormat:          format,
	}
}
