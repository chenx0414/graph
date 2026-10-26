package graph

import (
	"strings"

	"path/filepath"
)

// GraphDocumentationPaths are the read-only Agent-facing documentation locations.
type GraphDocumentationPaths struct {
	Root     string
	Main     string
	Examples string
}

// GraphDocumentationPaths resolves Graph's Agent documentation from the running checkout.
func GraphDocumentationPathsOf(appRoot ...string) GraphDocumentationPaths {
	root := GraphApplicationRoot()
	if len(appRoot) > 0 && appRoot[0] != "" {
		root = appRoot[0]
	}
	docs := filepath.Join(root, "docs", "agent")
	return GraphDocumentationPaths{
		Root:     docs,
		Main:     filepath.Join(docs, "README.md"),
		Examples: filepath.Join(root, "examples"),
	}
}

// GraphDocumentationPrompt is the host documentation block inserted into an Agent prompt.
func GraphDocumentationPrompt(paths GraphDocumentationPaths, compact ...bool) string {
	if len(compact) > 0 && compact[0] {
		return strings.Join([]string{
			"Graph host documentation: " + paths.Main + ". Read relevant topics for Graph runtime, tools, recovery, configuration, or harness changes.",
			"Before graph build/validate/start/patch: " + filepath.Join(paths.Root, "graph-v2.md") + "; native examples: " + filepath.Join(paths.Root, "..", "design-graph-examples.md") + ". Host API: schemaVersion:2, interface deliveries.",
			"Topic index: " + paths.Main + "; additional docs: " + paths.Root + "; examples: " + paths.Examples + ". Read the complete relevant topic and follow references needed for the operation.",
			"These paths describe the running host. Resolve topic references there, and examples under the examples path. Business-checkout docs and old conversation memory may describe a different API.",
		}, "\n")
	}
	return strings.Join([]string{
		"Graph documentation (read when the user asks about Graph itself, its Agent runtime, tools, task execution, recovery, permissions or configuration, and whenever you change Graph's own code, prompts or harness):",
		"- Main documentation: " + paths.Main,
		"- Running Graph API: schemaVersion:2, interface deliveries. To build, validate, start or patch a graph, read " + filepath.Join(paths.Root, "graph-v2.md") + " first; complete native examples: " + filepath.Join(paths.Root, "..", "design-graph-examples.md"),
		"- Additional docs: " + paths.Root,
		"- Examples: " + paths.Examples + " (runtime demos and acceptance fixtures)",
		"- These absolute paths belong to the running application. A business checkout may contain an older Graph version: its docs and source describe the task target, not this host API. Do not infer runtime tool arguments from that checkout or old conversation memory.",
		"- When reading Graph docs or examples, resolve topic paths under Additional docs and `examples/...` under Examples, not the current working directory",
		"- When asked about: task orchestration (`graph-overview.md`), execution and recovery (`execution-model.md`, `permissions-and-recovery.md`), tools and capabilities (`capabilities.md`), Git and artifacts (`artifacts-and-git.md`), prompt and tool configuration (`self-configuration.md`), model, provider and subscription configuration (`models-and-providers.md`), Agent recipe authoring (`agent-recipes.md`), reusable Matt team assembly and plan/rework workflow (`matt-team.md`), troubleshooting (`troubleshooting.md`)",
		"- Read the complete relevant topic. Follow only references needed for the current operation; implementation reports, historical ADRs and the full spec are for deeper investigation, not a prerequisite to building a graph.",
	}, "\n")
}
