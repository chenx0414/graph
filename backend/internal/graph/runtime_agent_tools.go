package graph

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
)

// ToolDefinition is one tool the Agent may call.
//
// It mirrors the Pi SDK's ToolDefinition (node_modules/@earendil-works/pi-coding-agent,
// dist/core/extensions/types.d.ts). The SDK is not ported: the Go process hands the tool
// surface to the Node worker as data (PiWorkerTool) and calls Execute itself.
type ToolDefinition struct {
	// Name is the tool name the LLM uses in a tool call.
	Name string
	// Label is the human-readable label for the UI.
	Label string
	// Description is the description the LLM sees.
	Description string
	// PromptSnippet is the one-line snippet for the available-tools section of the default
	// system prompt. It is optional: a custom tool is omitted from that section without it.
	PromptSnippet *string
	// PromptGuidelines are the guideline bullets appended to the system prompt Guidelines
	// section while this tool is active.
	PromptGuidelines []string
	// Parameters is the JSON schema of the tool arguments.
	Parameters Json
	// PrepareArguments prepares the raw tool call arguments before schema validation.
	PrepareArguments func(args any) any
	// Execute runs the tool.
	Execute func(toolCallId string, params any) (any, error)
	// ExternallyGated marks a tool whose Execute already passes the send gate at its own
	// effect boundary.
	ExternallyGated bool
}

// AgentToolsGraphManagement is the graph control surface the main Agent needs.
type AgentToolsGraphManagement struct {
	GraphCreate  func(input map[string]any) any
	GraphPatch   func(input map[string]any) any
	GraphInspect func(input map[string]any) any
	GraphControl func(input map[string]any) any
	GraphSend    func(input map[string]any) any
	// HarnessCompare reads the behavioral contrast of the candidates of one
	// task. It is the comparison half of the self-improvement loop and it
	// lives with the graph facts it reads.
	HarnessCompare func(input map[string]any) any
	// HarnessExperience reads the lessons earlier tasks adopted per domain.
	HarnessExperience func(input map[string]any) any
	// HarnessProbe runs one task under several harnesses and contrasts them.
	HarnessProbe func(input HarnessProbeInput) HarnessProbeResult
	// HarnessEvidence reads the evidence of the caller's own run.
	HarnessEvidence func(input HarnessEvidenceInput) HarnessEvidenceResult
	// HarnessDecision records the adopted candidate and the lesson it taught.
	HarnessDecision func(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult
	// HarnessFriction records friction the project met but has not solved.
	HarnessFriction func(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult
}

// AgentToolsSystemChange is one proposed change of the Graph host itself.
type AgentToolsSystemChange struct {
	Title   string
	Problem string
	Change  map[string]any
	Impact  *string
	Risk    *string
}

// AgentToolsSystemContext is the read-only host inventory the system tools need.
type AgentToolsSystemContext struct {
	SystemSummary       func() map[string]any
	SystemDiagnostics   func() map[string]any
	ProposeSystemChange func(input AgentToolsSystemChange) map[string]any
	ApplySystemChange   func(proposalID string) map[string]any
}

// AgentToolsRsi is the self-improvement surface the RSI tools need.
type AgentToolsRsi struct {
	Status func(compare bool) any
	Apply  func(input any, context PiAdapterRsiContext) map[string]any
}

// AgentToolsHumanCheck is the main Agent's review of one human acceptance check.
type AgentToolsHumanCheck struct {
	QuestionId string
	Approve    bool
	Note       string
	RequestId  string
}

// AgentToolsControlTask is one task control action of the main Agent.
type AgentToolsControlTask struct {
	Action    string
	TaskId    *string
	NodeId    *string
	Text      *string
	Tokens    *int
	Reason    *string
	RequestId string
}

// AgentToolsWriteLedger records the writes one turn makes.
type AgentToolsWriteLedger struct {
	Ledger     *WriteLedger
	TaskId     string
	NodeId     string
	InstanceId *string
	TurnId     string
}

// AgentToolsArtifactService is the shared artifact surface the tools need.
type AgentToolsArtifactService struct {
	// AllowedNamespaces are the artifact namespaces this Agent may write.
	AllowedNamespaces []string
	// CanPromote reports whether this Agent may promote an artifact.
	CanPromote bool
	List       func(query ArtifactQuery) ArtifactPage
	Get        func(artifactId string, version *int) ArtifactRecord
	Read       func(artifactId string, version int, maxBytes int) ArtifactRead
	Publish    func(input PublishArtifactInput) ArtifactRecord
	Retire     func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	Promote    func(input ArtifactPromoteInput) ArtifactRecord
}

// AgentToolsInput is everything one Agent session's tool surface is built from.
type AgentToolsInput struct {
	// Workspace is the work copy the tools read and write.
	Workspace string
	// Role is master, worker or reviewer.
	Role string
	// ReadRoots are the directories beside the workspace the tools may read.
	ReadRoots []string
	// Catalog is the capability catalog the resource tools read.
	Catalog *Catalog
	// Access is the resolved host access policy.
	Access *ResolvedAccessPolicy
	// ReadOnly turns off the tools that change business files.
	ReadOnly bool
	// Run executes one allowed command in the work copy.
	Run func(command string, args []string, signal *AbortSignal) CommandResult
	// CommitWorkspace commits the named paths of the work copy.
	CommitWorkspace func(paths []string, message string) any
	// Fetch reads one granted HTTP document.
	Fetch func(url string, signal *AbortSignal) RetrievalResult
	// ReadGraph reads one slice of the frozen graph definition.
	ReadGraph func(input GraphSectionQuery) any
	// OnAskUser hands a question to the session that can durably record it.
	OnAskUser func(request PiAdapterAskedQuestion)
	// Peers is the same-graph Agent channel. It holds a PiAdapterPeerTools.
	Peers any
	// Artifacts is the shared artifact workspace. It holds a PiAdapterArtifactService.
	Artifacts any
	// Conversations are the channels to other conversations.
	Conversations ConversationToolChannel
	// Supervisor is the conversation control surface.
	Supervisor PiAdapterSupervisor
	// GraphManagement is the graph control surface of the main Agent.
	GraphManagement AgentToolsGraphManagement
	// SystemContext is the read-only host inventory.
	SystemContext *AgentToolsSystemContext
	// Rsi is the self-improvement surface.
	Rsi *AgentToolsRsi
	// RsiContext names the operation a self-improvement change belongs to.
	RsiContext PiAdapterRsiContext
	// PendingHumanChecks lists the human acceptance checks nobody looked at yet.
	PendingHumanChecks func() any
	// ReviewHumanCheck records the main Agent's review of a human acceptance check.
	ReviewHumanCheck func(input AgentToolsHumanCheck) any
	// ControlTask controls a task of this conversation.
	ControlTask func(input AgentToolsControlTask) any
	// WriteLedger records the writes one turn makes.
	WriteLedger *AgentToolsWriteLedger
}

// agentToolsImageMimeTypes are the image types the read tool returns inline.
var agentToolsImageMimeTypes = map[string]string{
	".bmp":  "image/bmp",
	".gif":  "image/gif",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
}

// agentToolsGitReadSubcommands are the read-only git subcommands the tool allows.
var agentToolsGitReadSubcommands = []string{
	"status", "log", "diff", "show", "blame", "describe", "rev-parse", "ls-files", "shortlog", "grep", "rev-list",
}

// agentToolsGitOutputLimit caps the git output before it falls back to --stat.
const agentToolsGitOutputLimit = 20_000

// agentToolsArtifactTrusts are the trust levels the artifact tools accept.
var agentToolsArtifactTrusts = []string{"unverified", "reviewed", "accepted"}

// agentToolsCapabilityKinds are the capability kinds the search tool accepts.
var agentToolsCapabilityKinds = []string{"skill", "mcp", "extension", "pi-extension", "prompt"}

// agentToolsControlActions are the task control actions the tool accepts.
var agentToolsControlActions = []string{"pause", "resume", "abandon", "set_budget", "steer"}

// agentToolsProblemActions are the problem actions the tool accepts.
var agentToolsProblemActions = []string{"retry", "acknowledge", "respond", "reconcile_usage", "escalate"}

// agentToolsVersionedID matches a recipe id with a version suffix.
var agentToolsVersionedID = regexp.MustCompile(`^(.*)@[1-9]\d*$`)

// AgentTools is the workspace, result, supervisor and granted retrieval tools
// of one production Agent session.
func AgentTools(input AgentToolsInput) []ToolDefinition {
	root, err := filepath.EvalSymlinks(input.Workspace)
	if err != nil {
		panic(err)
	}
	readRoots := []string{}
	for _, item := range input.ReadRoots {
		resolved, err := filepath.EvalSymlinks(item)
		if err != nil {
			panic(err)
		}
		readRoots = append(readRoots, resolved)
	}
	hostRead := IsHostRead(input.Access)
	hostWrite := IsHostWrite(input.Access)
	protectedReadPathExceptions := agentToolsUnique(append([]string{root}, readRoots...))
	protectedWritePathExceptions := []string{}
	if hostWrite {
		protectedWritePathExceptions = []string{root}
	}
	protectedPaths := []string{}
	if input.Access != nil {
		protectedPaths = input.Access.ProtectedPaths
	}
	pathOptions := BoundedPathOptions{
		AllowGitMetadata:             input.Access != nil && input.Access.Filesystem.GitMetadata == "writable",
		ProtectedPaths:               protectedPaths,
		ProtectedReadPathExceptions:  protectedReadPathExceptions,
		ProtectedWritePathExceptions: protectedWritePathExceptions,
	}
	artifacts := agentToolsArtifactsOf(input.Artifacts)
	peers := agentToolsPeersOf(input.Peers)

	handlers := map[string]func(id string, params map[string]any) any{}
	for _, group := range []map[string]func(id string, params map[string]any) any{
		agentToolsGraphHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsWorkspaceHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsArtifactsHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsSupervisorHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsResourcesHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsSystemHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsHarnessHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
		agentToolsConversationHandlers(input, root, readRoots, hostRead, hostWrite, pathOptions, artifacts, peers),
	} {
		for name, handler := range group {
			handlers[name] = handler
		}
	}

	features := AgentToolFeatures{
		GraphManagement: input.GraphManagement.GraphCreate != nil,
		GraphRead:       input.ReadGraph != nil,
		WorkspaceCommit: input.CommitWorkspace != nil,
		Role:            input.Role,
		ReadOnly:        input.ReadOnly,
		Run:             input.Run != nil,
		Fetch:           input.Fetch != nil,
		Catalog:         input.Catalog != nil,
		Harness:         input.GraphManagement.HarnessCompare != nil,
	}
	if artifacts.present {
		access := artifacts.access
		features.Artifacts = &AgentArtifactAccess{AllowedNamespaces: access.AllowedNamespaces, CanPromote: access.CanPromote}
	}
	if agentToolsSupervisorPresent(input.Supervisor) {
		features.Supervisor = &AgentSupervisorFeatures{
			ValidateProposal:   input.Supervisor.ValidateProposal != nil,
			GraphState:         input.Supervisor.GraphState != nil,
			TaskStatus:         input.Supervisor.TaskStatus != nil,
			ListProjects:       input.Supervisor.ListProjects != nil,
			BindProject:        input.Supervisor.BindProject != nil,
			ListProblems:       input.Supervisor.ListProblems != nil,
			ResolveProblem:     input.Supervisor.ResolveProblem != nil,
			WithdrawDraft:      input.Supervisor.WithdrawDraft != nil,
			ConfirmDraft:       input.Supervisor.ConfirmDraft != nil,
			ArchiveDraft:       input.Supervisor.ArchiveDraft != nil,
			RestoreDraft:       input.Supervisor.RestoreDraft != nil,
			DeleteDraft:        input.Supervisor.DeleteDraft != nil,
			PendingHumanChecks: input.PendingHumanChecks != nil && input.ReviewHumanCheck != nil,
			ReviewHumanCheck:   input.PendingHumanChecks != nil && input.ReviewHumanCheck != nil,
			ControlTask:        input.ControlTask != nil,
		}
	}
	if input.Conversations.List != nil {
		features.Conversations = &AgentConversationFeatures{Read: true, Write: input.Conversations.Send != nil}
	}
	if peers != nil {
		features.Peers = true
	}
	if input.SystemContext != nil {
		features.SystemContext = &AgentSystemFeatures{
			SystemSummary:       input.SystemContext.SystemSummary != nil,
			SystemDiagnostics:   input.SystemContext.SystemDiagnostics != nil,
			ProposeSystemChange: input.SystemContext.ProposeSystemChange != nil,
			ApplySystemChange:   input.SystemContext.ApplySystemChange != nil,
		}
	}
	if input.Rsi != nil && (input.Rsi.Status != nil || input.Rsi.Apply != nil) {
		features.Rsi = &AgentRsiFeatures{Status: input.Rsi.Status != nil, Apply: input.Rsi.Apply != nil}
	}
	tools := []ToolDefinition{}
	for _, declaration := range DescribeAgentTools(features) {
		tool := ToolDefinition{
			Name: declaration.Name, Label: declaration.Label, Description: declaration.Description,
			Parameters: declaration.Parameters, PrepareArguments: declaration.PrepareArguments,
			ExternallyGated: declaration.ExternallyGated,
		}
		if handler, ok := handlers[declaration.Name]; ok {
			tool.Execute = func(id string, raw any) (result any, err error) {
				// The TypeScript handler throws; the host turns that refusal into
				// the tool error the model reads, instead of losing the turn.
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					switch failure := recovered.(type) {
					case *RuntimeError:
						result, err = nil, failure
					case error:
						result, err = nil, failure
					default:
						err = errors.New(fmt.Sprint(recovered))
					}
				}()
				return handler(id, agentToolsParams(raw)), nil
			}
		}
		tools = append(tools, tool)
	}
	return tools
}

// agentToolsFailure is the tool result a refusal answers with.
//
// The TypeScript daemon threw inside the tool body and the SDK turned that
// throw into the error result the model reads, reason and all. The Go daemon
// refuses from its own process, and a bare error crossing that boundary is
// not a tool result at all: the worker would answer "Tool returned an invalid
// content result" and the model would never learn why the call was refused.
// The refusal travels as the result the worker already understands.
func agentToolsFailure(failure error) map[string]any {
	reason := "The tool call was refused"
	if failure != nil {
		reason = failure.Error()
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": reason}},
		"details": map[string]any{},
		"isError": true,
	}
}
