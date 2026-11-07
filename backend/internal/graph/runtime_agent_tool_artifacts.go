package graph

import (
	"strings"
)

func artifactToolDeclarations(set agentToolContext) []AgentToolDeclaration {
	main := set.main
	features := set.features
	namespaces := []string{}
	if features.Artifacts != nil {
		namespaces = features.Artifacts.AllowedNamespaces
	}
	publishTail := ""
	if main {
		publishTail = " Set graphId to publish or revise an artifact in a graph you own; omit it to publish in your own task. A revision keeps the namespace, the name and every earlier version."
	}
	listLead := "List only shared artifacts owned by your current graph; subgraph nodes share the top-level graph workspace."
	if main {
		listLead = "List published task artifacts and shared project knowledge."
	}
	schemaNote := "Optional schema identity in kind@version form, e.g. source-list@1. The kind starts with a lowercase letter and contains lowercase letters, digits, dots, underscores or hyphens; version is a positive integer. Omit when no schema identity is needed."
	publishFields := []tbField{}
	publishRequired := []string{"namespace", "name", "requestId"}
	if main {
		publishFields = append(publishFields, tbField{"graphId", tbOptional(tbString(map[string]any{"minLength": 1}))})
	}
	publishFields = append(publishFields,
		tbField{"namespace", tbString(nil)}, tbField{"name", tbString(nil)},
		tbField{"sourcePath", tbOptional(tbString(nil))}, tbField{"content", tbOptional(tbString(nil))},
		tbField{"mediaType", tbOptional(tbString(nil))},
		tbField{"schema", tbOptional(tbString(map[string]any{"description": schemaNote}))},
		tbField{"title", tbOptional(tbString(nil))}, tbField{"summary", tbOptional(tbString(nil))},
		tbField{"tags", tbOptional(tbArray(tbString(nil)))},
		tbField{"expectedVersion", tbOptional(tbNumber())},
		tbField{"metadata", tbOptional(tbRecord())},
		tbField{"requestId", tbString(nil)},
	)
	return []AgentToolDeclaration{
		{Name: "read", Label: "Read file", Description: "Read a UTF-8 file or supported image from the instance workspace or a bound capability.", Parameters: tbObject([]tbField{{"path", tbString(nil)}}, []string{"path"}), Available: true},
		{Name: "write_file", Label: "Write file", Description: "Write a UTF-8 file inside the instance workspace.", Parameters: tbObject([]tbField{{"path", tbString(nil)}, {"content", tbString(nil)}}, []string{"path", "content"}), Available: !features.ReadOnly},
		{Name: "list_dir", Label: "List directory", Description: "List files in a workspace directory or a permitted read-only capability directory.", Parameters: tbObject([]tbField{{"path", tbString(nil)}}, []string{"path"}), Available: true},
		{Name: "workspace_commit", Label: "Commit workspace files", Description: "Commit the named paths in this node worktree before publishing code. Returns repository, commit and worktree. It publishes no artifact and delivers nothing to the target branch.", Parameters: tbObject([]tbField{{"paths", tbArrayBound(tbString(nil), 1, 256)}, {"message", tbString(nil)}}, []string{"paths", "message"}), Available: features.WorkspaceCommit && !features.ReadOnly && !main && features.Role != "reviewer"},
		{Name: "artifact_list", Label: "List shared artifacts", Description: listLead + " Metadata only - use artifact_read for content.", Parameters: tbObject([]tbField{{"namespace", tbOptional(tbString(nil))}, {"prefix", tbOptional(tbString(nil))}, {"schema", tbOptional(tbString(map[string]any{"description": schemaNote}))}, {"tag", tbOptional(tbString(nil))}, {"trust", tbOptional(tbString(nil))}, {"includeRetired", tbOptional(tbBool())}, {"latestOnly", tbOptional(tbBool())}, {"limit", tbOptional(tbNumber())}, {"cursor", tbOptional(tbString(nil))}}, nil), Available: features.Artifacts != nil},
		{Name: "artifact_read", Label: "Read shared artifact", Description: "Read one immutable artifact by artifactId. Omit version for the latest published version: discovery, not a frozen reference. Text returns within maxBytes; binary content returns its path and metadata.", Parameters: tbObject([]tbField{{"artifactId", tbString(nil)}, {"version", tbOptional(tbNumber())}, {"maxBytes", tbOptional(tbNumber())}}, []string{"artifactId"}), Available: features.Artifacts != nil},
		{Name: "artifact_publish", Label: "Publish shared artifact", Description: "Publish an immutable version from sourcePath or content, never both. sourcePath is inside this work copy. expectedVersion guards updates. Declared deliverables publish at settlement. Namespaces: " + strings.Join(namespaces, ", ") + "." + publishTail, Parameters: tbObject(publishFields, publishRequired), Available: features.Artifacts != nil},
		{Name: "artifact_promote", Label: "Promote artifact to project knowledge", Description: "Promote one exact task artifact version into project-scoped shared knowledge for later tasks in the same project. The source version is neither mutated nor retired.", Parameters: tbObject([]tbField{{"artifactId", tbString(nil)}, {"version", tbNumber()}, {"requestId", tbString(nil)}}, []string{"artifactId", "version", "requestId"}), Available: features.Artifacts != nil && features.Artifacts.CanPromote},
		{Name: "run_command", Label: "Run command", Description: "Run an allowed command in the work copy: command is a bare executable name (node or git), args a string array. It is not a shell; git only supports read-only status, diff, log and show.", Parameters: tbObject([]tbField{{"command", tbString(nil)}, {"args", tbOptional(tbArray(tbString(nil)))}}, []string{"command"}), Available: features.Run && !features.ReadOnly, ExternallyGated: true},
		{Name: "git", Label: "Git (read-only)", Description: "Run one read-only git command in the work copy. Output is capped at 20000 characters (a longer diff or log falls back to --stat). Allowed: status, log, diff, show, blame, describe, rev-parse, ls-files, shortlog, grep, rev-list.", Parameters: tbObject([]tbField{{"subcommand", tbString(nil)}, {"args", tbOptional(tbArray(tbString(nil)))}, {"path", tbOptional(tbString(nil))}}, []string{"subcommand"}), Available: features.Run && !features.ReadOnly, ExternallyGated: true},
		{Name: "fetch", Label: "Fetch URL", Description: "Fetch a text document from a granted domain and return its body.", Parameters: tbObject([]tbField{{"url", tbString(nil)}}, []string{"url"}), Available: features.Fetch, ExternallyGated: true},
	}
}
