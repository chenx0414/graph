package graph

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
)

type ToolDefinition struct {
	Name             string
	Label            string
	Description      string
	PromptSnippet    *string
	PromptGuidelines []string
	Parameters       Json
	PrepareArguments func(args any) any
	Execute          func(toolCallId string, params any) (any, error)
	ExternallyGated  bool
	Async            bool
	Deferred         func(toolCallId string, params any, signal *AbortSignal) (any, error)
}

type AgentToolsGraphManagement struct {
	GraphCreate       func(input map[string]any) any
	GraphPatch        func(input map[string]any) any
	GraphInspect      func(input map[string]any) any
	GraphControl      func(input map[string]any) any
	GraphSend         func(input map[string]any) any
	HarnessCompare    func(input map[string]any) any
	HarnessExperience func(input map[string]any) any
	HarnessProbe      func(input HarnessProbeInput) HarnessProbeResult
	HarnessEvidence   func(input HarnessEvidenceInput) HarnessEvidenceResult
	HarnessDecision   func(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult
	HarnessFriction   func(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult
}

type AgentToolsSystemChange struct {
	Title   string
	Problem string
	Change  map[string]any
	Impact  *string
	Risk    *string
}

type AgentToolsSystemContext struct {
	SystemSummary       func() map[string]any
	SystemDiagnostics   func() map[string]any
	ProposeSystemChange func(input AgentToolsSystemChange) map[string]any
	ApplySystemChange   func(proposalID string) map[string]any
}

type AgentToolsRsi struct {
	Status func(compare bool) any
	Apply  func(input any, context PiAdapterRsiContext) map[string]any
}

type AgentToolsHumanCheck struct {
	QuestionId string
	Approve    bool
	Note       string
	RequestId  string
}

type AgentToolsControlTask struct {
	Action          string
	TaskId          *string
	NodeId          *string
	Text            *string
	Tokens          *int
	Reason          *string
	RequestId       string
	SourceMessageID string
	Instruction     string
}

type AgentToolsWriteLedger struct {
	Ledger     *WriteLedger
	TaskId     string
	NodeId     string
	InstanceId *string
	TurnId     string
}

type AgentToolsArtifactService struct {
	AllowedNamespaces []string
	CanPromote        bool
	List              func(query ArtifactQuery) ArtifactPage
	Get               func(artifactId string, version *int) ArtifactRecord
	Read              func(artifactId string, version int, maxBytes int) ArtifactRead
	Publish           func(input PublishArtifactInput) ArtifactRecord
	Retire            func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	Promote           func(input ArtifactPromoteInput) ArtifactRecord
}

type AgentToolsInput struct {
	Workspace          string
	Role               string
	ReadRoots          []string
	Catalog            *Catalog
	ReadOnly           bool
	Run                func(command string, args []string, signal *AbortSignal) CommandResult
	RunWithTimeout     func(command string, args []string, signal *AbortSignal, timeoutMs int) CommandResult
	CommitWorkspace    func(paths []string, message string) any
	Fetch              func(url string, signal *AbortSignal) RetrievalResult
	ReadGraph          func(input GraphSectionQuery) any
	OnAskSupervisor    func(request PiAdapterAskedQuestion)
	OnNotifySupervisor func(notice PiAdapterSupervisorNotice) any
	Peers              any
	Artifacts          any
	Supervisor         PiAdapterSupervisor
	GraphManagement    AgentToolsGraphManagement
	SystemContext      *AgentToolsSystemContext
	Rsi                *AgentToolsRsi
	RsiContext         PiAdapterRsiContext
	ControlTask        func(input AgentToolsControlTask) any
	Desktop            *AgentToolsDesktop
	WriteLedger        *AgentToolsWriteLedger
}

var agentToolsImageMimeTypes = map[string]string{
	".bmp":  "image/bmp",
	".gif":  "image/gif",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
}

var agentToolsGitReadSubcommands = []string{
	"status", "log", "diff", "show", "blame", "describe", "rev-parse", "ls-files", "shortlog", "grep", "rev-list",
}

const agentToolsGitOutputLimit = 20_000

var agentToolsArtifactTrusts = []string{"unverified", "reviewed", "accepted"}

var agentToolsCapabilityKinds = []string{"skill", "mcp", "extension", "pi-extension", "prompt"}

var agentToolsControlActions = []string{"pause", "resume", "abandon", "set_budget", "steer", "stop_node"}

var agentToolsProblemActions = []string{"retry", "acknowledge", "respond", "reconcile_usage", "escalate"}

var agentToolsVersionedID = regexp.MustCompile(`^(.*)@[1-9]\d*$`)

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
	hostRead := true
	hostWrite := true
	protectedReadPathExceptions := agentToolsUnique(append([]string{root}, readRoots...))
	protectedWritePathExceptions := []string{}
	if hostWrite {
		protectedWritePathExceptions = []string{root}
	}
	pathOptions := BoundedPathOptions{
		AllowGitMetadata:             true,
		ProtectedPaths:               []string{},
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
		agentToolsDesktopHandlers(input),
	} {
		for name, handler := range group {
			handlers[name] = handler
		}
	}

	features := AgentToolFeatures{
		AskSupervisor:   input.OnAskSupervisor != nil || input.OnNotifySupervisor != nil,
		GraphManagement: input.GraphManagement.GraphCreate != nil,
		GraphRead:       input.ReadGraph != nil,
		WorkspaceCommit: input.CommitWorkspace != nil,
		Role:            input.Role,
		ReadOnly:        input.ReadOnly,
		Run:             input.Run != nil || input.RunWithTimeout != nil,
		Fetch:           input.Fetch != nil,
		Catalog:         input.Catalog != nil,
		Harness:         input.GraphManagement.HarnessCompare != nil,
		Desktop:         input.Desktop != nil && input.Desktop.Bin != "",
	}
	if artifacts.present {
		access := artifacts.access
		features.Artifacts = &AgentArtifactAccess{AllowedNamespaces: access.AllowedNamespaces, CanPromote: access.CanPromote}
	}
	if agentToolsSupervisorPresent(input.Supervisor) {
		features.Supervisor = &AgentSupervisorFeatures{
			ResumeWork:       input.Supervisor.ResumeWork != nil,
			DelegateWork:     input.Supervisor.DelegateWork != nil,
			ProposeWorkGraph: input.Supervisor.ProposeWorkGraph != nil,
			ReadWorkDraft:    input.Supervisor.ReadWorkDraft != nil,
			ValidateProposal: input.Supervisor.ValidateProposal != nil,
			GraphState:       input.Supervisor.GraphState != nil,
			TaskStatus:       input.Supervisor.TaskStatus != nil,
			ListProjects:     input.Supervisor.ListProjects != nil,
			ListProblems:     input.Supervisor.ListProblems != nil,
			ResolveProblem:   input.Supervisor.ResolveProblem != nil,
			WithdrawDraft:    input.Supervisor.WithdrawDraft != nil,
			ConfirmDraft:     input.Supervisor.ConfirmDraft != nil,
			ControlTask:      input.ControlTask != nil,
		}
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
		if tool.PrepareArguments == nil {
			tool.PrepareArguments = PrepareFreeFormArguments(declaration.Parameters)
		}
		if handler, ok := handlers[declaration.Name]; ok {
			tool.Execute = func(id string, raw any) (result any, err error) {
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
