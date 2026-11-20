package gate

import (
	"path/filepath"
	"strings"
)

const FeatureMapPath = "FEATURE_MAP.md"

const GateFeatureMapPath = FeatureMapPath

var agentInstructionRoots = []string{
	"AGENTS.md",
	FeatureMapPath,
}

var vendoredMarkdownRoots = []string{
	".agents/skills/",
}

var embeddedPromptFiles = []string{
	"presets/bootstrap/master/agent.md",
	"backend/internal/graph/embedded/presets/bootstrap/master/agent.md",
}

func DocumentationAllowed(path string) (bool, string) {
	clean := filepath.ToSlash(strings.TrimSpace(path))
	for _, allowed := range agentInstructionRoots {
		if clean == allowed {
			return true, "the two documents an agent reads"
		}
	}
	for _, root := range vendoredMarkdownRoots {
		if strings.HasPrefix(clean, root) {
			return true, "vendored capability documentation"
		}
	}
	for _, allowed := range embeddedPromptFiles {
		if clean == allowed {
			return true, "embedded preset prompt, compiled into the binary"
		}
	}
	return false, "prose does not enforce anything: express the rule as a type, a test, a gate or a hook, or record the fact in " + FeatureMapPath
}
