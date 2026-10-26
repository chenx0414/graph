package graph

// graph:allow-large-file: the tool schema table, one declaration per tool

import (
	"strings"

	"errors"
)

// AgentToolFeatures are the host bindings a declaration may see. A non-nil object is truthy.
type AgentToolFeatures struct {
	GraphManagement bool
	GraphRead       bool
	WorkspaceCommit bool
	Role            string
	ReadOnly        bool
	Run             bool
	Fetch           bool
	Catalog         bool
	Artifacts       *AgentArtifactAccess
	Supervisor      *AgentSupervisorFeatures
	SystemContext   *AgentSystemFeatures
	Rsi             *AgentRsiFeatures
	Harness         bool
	Conversations   *AgentConversationFeatures
	Peers           bool
}

// AgentArtifactAccess is the artifact namespaces one role may use.
type AgentArtifactAccess struct {
	AllowedNamespaces []string
	CanPromote        bool
}

// AgentSupervisorFeatures are the conversation controls offered to main.
type AgentSupervisorFeatures struct {
	ValidateProposal   bool
	GraphState         bool
	TaskStatus         bool
	ListProjects       bool
	BindProject        bool
	ListProblems       bool
	ResolveProblem     bool
	WithdrawDraft      bool
	ConfirmDraft       bool
	ArchiveDraft       bool
	RestoreDraft       bool
	DeleteDraft        bool
	ControlTask        bool
	PendingHumanChecks bool
	ReviewHumanCheck   bool
}

// AgentSystemFeatures are the read-only host inventory tools.
type AgentSystemFeatures struct {
	SystemSummary       bool
	SystemDiagnostics   bool
	ProposeSystemChange bool
	ApplySystemChange   bool
}

// AgentRsiFeatures are the self-improvement tools.
type AgentRsiFeatures struct {
	Status bool
	Apply  bool
}

// AgentConversationFeatures are channels to other conversations.
type AgentConversationFeatures struct {
	Read  bool
	Write bool
}

// agentToolContext carries what the declaration groups share: the role of the
// agent and the host bindings it may see.
type agentToolContext struct {
	main     bool
	features AgentToolFeatures
}

// AgentToolDeclaration is a tool surface before a handler is bound.
type AgentToolDeclaration struct {
	Name             string
	Label            string
	Description      string
	Parameters       any
	PrepareArguments func(args any) any
	Available        bool
	ExternallyGated  bool
}

// AGENT_TOOL_ARGUMENT_HINTS are host-free argument hints attached by tool name.
var AGENT_TOOL_ARGUMENT_HINTS = map[string]func(args any) string{
	"apply_rsi_change": RsiChangeShapeHint,
}

// PrepareToolArguments returns the hint seam, or nil when the tool has none.
func PrepareToolArguments(name string) func(args any) any {
	hint := AGENT_TOOL_ARGUMENT_HINTS[name]
	if hint == nil {
		return nil
	}
	return func(args any) any {
		problem := hint(args)
		if problem != "" {
			panic(errors.New(problem))
		}
		return args
	}
}

// AgentArtifactAccessFor is the namespace grant for one role and action.
func AgentArtifactAccessFor(input struct {
	Role   string
	Action string
}) AgentArtifactAccess {
	namespaces := []string{"plans", "research", "deliverables", "summaries"}
	if input.Role == "master" {
		namespaces = []string{"plans", "research", "reviews", "deliverables", "summaries"}
	} else if toolReviewAction(input.Action) {
		namespaces = []string{"reviews", "summaries"}
	}
	return AgentArtifactAccess{AllowedNamespaces: namespaces, CanPromote: input.Role == "master"}
}

func toolReviewAction(action string) bool {
	lower := strings.ToLower(action)
	return strings.Contains(lower, "review") || strings.Contains(lower, "verify") || strings.Contains(lower, "critic") || strings.Contains(lower, "jury")
}

// DescribeAgentTools returns the declarations that are available for these features.
func DescribeAgentTools(features AgentToolFeatures) []AgentToolDeclaration {
	declared := agentToolDeclarations(features)
	out := []AgentToolDeclaration{}
	for _, tool := range declared {
		if tool.Available {
			out = append(out, tool)
		}
	}
	return out
}

func agentToolDeclarations(features AgentToolFeatures) []AgentToolDeclaration {
	set := agentToolContext{main: features.Role == "master", features: features}
	declarations := []AgentToolDeclaration{}
	declarations = append(declarations, graphToolDeclarations(set)...)
	declarations = append(declarations, draftToolDeclarations(set)...)
	declarations = append(declarations, artifactToolDeclarations(set)...)
	declarations = append(declarations, sessionToolDeclarations(set)...)
	declarations = append(declarations, harnessToolDeclarations(set)...)
	return declarations
}

type tbField struct {
	name   string
	schema any
}

func tbObject(fields []tbField, required []string) map[string]any {
	properties := map[string]any{}
	for _, field := range fields {
		properties[field.name] = field.schema
	}
	schema := map[string]any{"type": "object", "properties": properties}
	if required == nil {
		required = []string{}
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func tbString(extra map[string]any) map[string]any {
	schema := map[string]any{"type": "string"}
	for key, value := range extra {
		schema[key] = value
	}
	return schema
}

func tbNumber() map[string]any { return map[string]any{"type": "number"} }

func tbInteger(extra map[string]any) map[string]any {
	schema := map[string]any{"type": "integer"}
	for key, value := range extra {
		schema[key] = value
	}
	return schema
}

func tbBool() map[string]any { return map[string]any{"type": "boolean"} }

func tbAny() map[string]any { return map[string]any{} }

func tbOptional(schema any) any { return schema }

func tbArray(items any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}

func tbArrayBound(items any, minItems, maxItems int) map[string]any {
	return map[string]any{"type": "array", "items": items, "minItems": minItems, "maxItems": maxItems}
}

func tbUnion(items []any) map[string]any {
	return map[string]any{"anyOf": items}
}

func tbUnionLiteral(values []string) map[string]any {
	items := make([]any, 0, len(values))
	for _, value := range values {
		items = append(items, map[string]any{"const": value})
	}
	return tbUnion(items)
}

func tbRecord() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": map[string]any{}}
}

func nativeProposalSchema() map[string]any {
	return tbObject([]tbField{
		{"requirementVersion", tbInteger(map[string]any{"minimum": 1})},
		{"summary", tbString(nil)},
		{"definition", tbAny()},
		{"acceptance", tbArray(tbObject([]tbField{{"id", tbString(nil)}, {"description", tbString(nil)}, {"checkNode", tbString(nil)}}, []string{"id", "description", "checkNode"}))},
		{"decisions", tbOptional(tbArray(tbString(nil)))},
	}, []string{"requirementVersion", "summary", "definition", "acceptance"})
}
