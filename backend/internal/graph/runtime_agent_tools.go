package graph

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
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
	// HarnessDecision records the adopted candidate and the lesson it taught.
	HarnessDecision func(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult
	// HarnessEvidence reads the evidence of the caller's own run.
	HarnessEvidence func(input HarnessEvidenceInput) HarnessEvidenceResult
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

	handlers := map[string]func(id string, params map[string]any) any{
		"graph_create": func(id string, params map[string]any) any {
			body := map[string]any{}
			for key, value := range params {
				body[key] = value
			}
			requestID, present := params["requestId"]
			if !present || requestID == nil {
				body["requestId"] = id
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphCreate(body)))
		},
		"graph_patch": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphPatch(params)))
		},
		"read_graph": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.ReadGraph(agentToolsGraphSectionQuery(params))))
		},
		"graph_inspect": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphInspect(params)))
		},
		"graph_control": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphControl(params)))
		},
		"graph_send": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphSend(params)))
		},
		"read": func(id string, params map[string]any) any {
			requested := agentToolsString(params["path"])
			mimeType := agentToolsImageMimeType(requested)
			if filepath.IsAbs(requested) {
				if hostRead {
					if mimeType != "" {
						return agentToolsImage(ReadHostBytes(requested, pathOptions), mimeType)
					}
					return agentToolsText(ReadHost(requested, pathOptions))
				}
				mount := agentToolsMount(append([]string{root}, readRoots...), requested)
				if mount == "" {
					panic(errors.New("Path is outside the workspace"))
				}
				if mimeType != "" {
					return agentToolsImage(ReadBoundedBytes(mount, requested), mimeType)
				}
				return agentToolsText(ReadBounded(mount, requested))
			}
			if mimeType != "" {
				return agentToolsImage(ReadBoundedBytes(root, requested), mimeType)
			}
			return agentToolsText(ReadBounded(root, requested))
		},
		"write_file": func(id string, params map[string]any) any {
			requested := agentToolsString(params["path"])
			capture := func(side string) {
				if input.WriteLedger == nil || input.WriteLedger.Ledger == nil {
					return
				}
				defer func() { _ = recover() }()
				input.WriteLedger.Ledger.Capture(side, WriteCaptureInput{
					TaskID: input.WriteLedger.TaskId, NodeID: input.WriteLedger.NodeId,
					InstanceID: input.WriteLedger.InstanceId, TurnID: input.WriteLedger.TurnId,
					ToolCallID: id, ToolName: "write_file", Path: requested, Workspace: root,
				})
			}
			capture("open")
			content := agentToolsString(params["content"])
			if hostWrite && filepath.IsAbs(requested) {
				WriteHost(requested, content, pathOptions)
			} else {
				WriteBounded(root, requested, content)
			}
			capture("close")
			return agentToolsText("Wrote " + agentToolsString(params["path"]))
		},
		"list_dir": func(id string, params map[string]any) any {
			requested := "."
			if agentToolsTruthy(params["path"]) {
				requested = agentToolsString(params["path"])
			}
			if filepath.IsAbs(requested) {
				if hostRead {
					return agentToolsText(strings.Join(ListHost(requested, pathOptions), "\n"))
				}
				mount := agentToolsMount(append([]string{root}, readRoots...), requested)
				if mount == "" {
					panic(errors.New("Path is outside the workspace"))
				}
				return agentToolsText(strings.Join(ListBounded(mount, requested), "\n"))
			}
			return agentToolsText(strings.Join(ListBounded(root, requested), "\n"))
		},
		"artifact_list": func(id string, params map[string]any) any {
			trust := agentToolsTrimmedString(params["trust"])
			if trust != "" && !agentToolsContains(agentToolsArtifactTrusts, trust) {
				panic(errors.New("Unsupported artifact trust"))
			}
			query := ArtifactQuery{}
			if value := agentToolsTrimmedString(params["namespace"]); value != "" {
				query.Namespace = value
			}
			if value := agentToolsTrimmedString(params["prefix"]); value != "" {
				query.Prefix = value
			}
			if value := agentToolsTrimmedString(params["schema"]); value != "" {
				query.Schema = value
			}
			if value := agentToolsTrimmedString(params["tag"]); value != "" {
				query.Tag = value
			}
			if trust != "" {
				query.Trust = trust
			}
			if value, ok := params["includeRetired"].(bool); ok {
				query.IncludeRetired = value
			}
			if value, ok := params["latestOnly"].(bool); ok {
				query.LatestOnly = &value
			}
			if value, ok := agentToolsNumber(params["limit"]); ok {
				limit := int(value)
				query.Limit = &limit
			}
			if value := agentToolsTrimmedString(params["cursor"]); value != "" {
				query.Cursor = value
			}
			return agentToolsText(stringifyJSON(artifacts.list(query)))
		},
		"artifact_read": func(id string, params map[string]any) any {
			artifactID := strings.TrimSpace(agentToolsString(params["artifactId"]))
			if artifactID == "" || len(artifactID) > 200 {
				panic(errors.New("A bounded artifactId is required"))
			}
			var version *int
			if _, present := params["version"]; present {
				value, ok := agentToolsNumberValue(params["version"])
				if !ok || value != float64(int(value)) || value < 1 {
					panic(errors.New("version must be a positive integer when provided"))
				}
				requested := int(value)
				version = &requested
			}
			resolved := version
			if resolved == nil {
				record := artifacts.get(artifactID, nil)
				resolved = &record.Version
			}
			maxBytes := 0
			if value, ok := agentToolsNumber(params["maxBytes"]); ok {
				maxBytes = int(value)
			}
			return agentToolsText(stringifyJSON(artifacts.read(artifactID, *resolved, maxBytes)))
		},
		"workspace_commit": func(id string, params map[string]any) any {
			raw, ok := params["paths"].([]any)
			message, messageIsString := params["message"].(string)
			if !ok || !messageIsString {
				Raise("invalid_input", "workspace_commit requires paths and message")
			}
			paths := []string{}
			for _, item := range raw {
				path, isString := item.(string)
				if !isString {
					Raise("invalid_input", "workspace_commit requires paths and message")
				}
				paths = append(paths, path)
			}
			return agentToolsText(stringifyJSON(input.CommitWorkspace(paths, message)))
		},
		"artifact_publish": func(id string, params map[string]any) any {
			if _, present := params["graphId"]; present && input.Role != "master" {
				Raise("permission", "Only main can select an artifact graph")
			}
			if raw, present := params["graphId"]; present {
				text, isString := raw.(string)
				if !isString || strings.TrimSpace(text) == "" {
					Raise("invalid_input", "graphId must be a nonempty string")
				}
			}
			namespace := strings.TrimSpace(agentToolsString(params["namespace"]))
			if !agentToolsContains(artifacts.access.AllowedNamespaces, namespace) {
				panic(errors.New("Namespace " + namespace + " is not writable by this Agent"))
			}
			var metadata map[string]any
			if raw, present := params["metadata"]; present {
				record := asMap(raw)
				if record == nil {
					Raise("invalid_input", "Artifact metadata must be an object")
				}
				metadata = record
			}
			var tags []string
			if raw, ok := params["tags"].([]any); ok {
				for _, item := range raw {
					tags = append(tags, agentToolsString(item))
				}
			}
			var expectedVersion *int64
			if value, ok := agentToolsNumber(params["expectedVersion"]); ok {
				number := int64(value)
				expectedVersion = &number
			}
			publish := PublishArtifactInput{
				Namespace: namespace, Name: agentToolsString(params["name"]),
				RequestId: agentToolsString(params["requestId"]), Tags: tags,
				ExpectedVersion: expectedVersion, Metadata: metadata,
			}
			// TODO(port): the TypeScript publish input carries an optional graphId, so an
			// artifact can be published into a graph the Agent owns. PublishArtifactInput
			// has no such field yet, so the graph is validated but not forwarded.
			if text, ok := params["sourcePath"].(string); ok && strings.TrimSpace(text) != "" {
				publish.SourcePath = text
			}
			if text, ok := params["content"].(string); ok {
				publish.Content = &text
			}
			if text, ok := params["mediaType"].(string); ok && strings.TrimSpace(text) != "" {
				publish.MediaType = strings.TrimSpace(text)
			}
			if text, ok := params["schema"].(string); ok && strings.TrimSpace(text) != "" {
				publish.Schema = strings.TrimSpace(text)
			}
			if text, ok := params["title"].(string); ok && strings.TrimSpace(text) != "" {
				publish.Title = strings.TrimSpace(text)
			}
			if text, ok := params["summary"].(string); ok && strings.TrimSpace(text) != "" {
				publish.Summary = strings.TrimSpace(text)
			}
			return agentToolsText(stringifyJSON(artifacts.publish(publish)))
		},
		"artifact_retire": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["version"])
			return agentToolsText(stringifyJSON(artifacts.retire(
				agentToolsString(params["artifactId"]), int(version),
				agentToolsString(params["reason"]), agentToolsString(params["requestId"]))))
		},
		"artifact_promote": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["version"])
			return agentToolsText(stringifyJSON(artifacts.promote(ArtifactPromoteInput{
				ArtifactId: agentToolsString(params["artifactId"]), Version: int(version),
				RequestId: agentToolsString(params["requestId"]),
			})))
		},
		"run_command": func(id string, params map[string]any) any {
			args := []string{}
			if raw, ok := params["args"].([]any); ok {
				for _, item := range raw {
					args = append(args, agentToolsString(item))
				}
			}
			result := input.Run(agentToolsString(params["command"]), args, nil)
			return agentToolsText(agentToolsCommandOutput(result))
		},
		"git": func(id string, params map[string]any) any {
			subcommand := strings.TrimSpace(agentToolsStringOrEmpty(params["subcommand"]))
			if !agentToolsContains(agentToolsGitReadSubcommands, subcommand) {
				panic(errors.New("Only read-only git subcommands: " + strings.Join(agentToolsGitReadSubcommands, ", ")))
			}
			args := []string{}
			if raw, ok := params["args"].([]any); ok {
				for _, item := range raw {
					args = append(args, agentToolsString(item))
				}
			}
			for _, value := range args {
				if len(value) > 200 || strings.ContainsAny(value, "\x00\r\n") {
					panic(errors.New("Invalid git argument"))
				}
			}
			for _, value := range args {
				if value == "--output" || strings.HasPrefix(value, "--exec") || strings.HasPrefix(value, "--no-index") {
					panic(errors.New("Unsupported git argument"))
				}
			}
			path := ""
			if raw, ok := params["path"].(string); ok {
				path = strings.TrimSpace(raw)
			}
			if path != "" && (strings.HasPrefix(path, "-") || strings.ContainsAny(path, "\x00\r\n")) {
				panic(errors.New("Invalid git path"))
			}
			base := append([]string{subcommand}, args...)
			full := agentToolsGitText(input, base, path)
			if len(full) <= agentToolsGitOutputLimit {
				return agentToolsText(full)
			}
			summary := agentToolsGitText(input, append([]string{subcommand, "--stat"}, args...), path)
			if len(summary) > agentToolsGitOutputLimit {
				summary = summary[:agentToolsGitOutputLimit]
			}
			return agentToolsText("output exceeded " + itoa(agentToolsGitOutputLimit) + " characters; --stat summary follows\n\n" + summary)
		},
		"fetch": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Fetch(agentToolsString(params["url"]), nil)))
		},
		"propose_graph": func(id string, params map[string]any) any {
			proposal := agentToolsNativeProposal(params["proposal"])
			receipt := input.Supervisor.Propose(proposal, agentToolsString(params["requestId"]), params["newVersion"] == true)
			return agentToolsText(stringifyJSON(receipt))
		},
		"withdraw_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			reason := agentToolsStringOrEmpty(params["reason"])
			receipt := input.Supervisor.WithdrawDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), Reason: &reason, RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"confirm_draft": func(id string, params map[string]any) any {
			instruction := strings.TrimSpace(agentToolsStringOrEmpty(params["instruction"]))
			if instruction == "" {
				Raise("invalid_input", "An instruction is required: record the words that authorised this confirmation")
			}
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			revision, _ := agentToolsNumberValue(params["draftRevision"])
			receipt := input.Supervisor.ConfirmDraft(PiAdapterConfirmDraft{
				ProposalVersion: int(version), DraftRevision: int(revision),
				TargetBranch: agentToolsStringOrEmpty(params["targetBranch"]), Instruction: instruction,
				RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"archive_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			receipt := input.Supervisor.ArchiveDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"restore_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			receipt := input.Supervisor.RestoreDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"delete_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			receipt := input.Supervisor.DeleteDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"validate_proposal": func(id string, params map[string]any) any {
			proposal := agentToolsNativeProposal(params["proposal"])
			return agentToolsText(stringifyJSON(input.Supervisor.ValidateProposal(proposal)))
		},
		"get_graph_state": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.GraphState()))
		},
		"get_task_status": func(id string, params map[string]any) any {
			taskId := agentToolsOptionalString(params, "taskId")
			nodeId := agentToolsOptionalString(params, "nodeId")
			waitForNode := agentToolsOptionalString(params, "waitForNode")
			var timeoutMs *int
			if value, ok := agentToolsNumber(params["timeoutMs"]); ok {
				truncated := int(value)
				timeoutMs = &truncated
			}
			if _, present := params["graphId"]; present {
				corrected := map[string]any{"taskId": "<graph id>"}
				if taskId != nil {
					corrected["taskId"] = *taskId
				} else if graphId := agentToolsOptionalString(params, "graphId"); graphId != nil {
					corrected["taskId"] = *graphId
				}
				if nodeId != nil {
					corrected["nodeId"] = *nodeId
				}
				if waitForNode != nil {
					corrected["waitForNode"] = *waitForNode
				}
				if timeoutMs != nil {
					corrected["timeoutMs"] = *timeoutMs
				}
				Raise("invalid_input", "get_task_status uses taskId, not graphId. Retry get_task_status("+
					stringifyJSON(corrected)+") with graphId removed.")
			}
			return agentToolsText(stringifyJSON(input.Supervisor.TaskStatus(PiAdapterTaskStatus{
				TaskId: taskId, NodeId: nodeId, WaitForNode: waitForNode, TimeoutMs: timeoutMs,
			})))
		},
		"list_projects": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.ListProjects()))
		},
		"bind_project": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.BindProject(PiAdapterBindProject{
				ProjectId: strings.TrimSpace(agentToolsString(params["projectId"])),
				RequestId: strings.TrimSpace(agentToolsString(params["requestId"])),
			})))
		},
		"list_problems": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.ListProblems()))
		},
		"list_human_checks": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.PendingHumanChecks()))
		},
		"review_human_check": func(id string, params map[string]any) any {
			approve, ok := params["approve"].(bool)
			if !ok {
				panic(errors.New("review_human_check requires approve as a boolean"))
			}
			return agentToolsText(stringifyJSON(input.ReviewHumanCheck(AgentToolsHumanCheck{
				QuestionId: strings.TrimSpace(agentToolsString(params["questionId"])),
				Approve:    approve,
				Note:       strings.TrimSpace(agentToolsStringOrEmpty(params["note"])),
				RequestId:  strings.TrimSpace(agentToolsString(params["requestId"])),
			})))
		},
		"resolve_problem": func(id string, params map[string]any) any {
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			if !agentToolsContains(agentToolsProblemActions, action) {
				panic(errors.New("Unsupported problem action"))
			}
			resolve := PiAdapterResolveProblem{
				QuestionId: strings.TrimSpace(agentToolsString(params["questionId"])),
				Action:     action,
				RequestId:  strings.TrimSpace(agentToolsString(params["requestId"])),
			}
			if response, ok := params["response"].(string); ok {
				value := strings.TrimSpace(response)
				resolve.Response = &value
			}
			if proof, ok := params["proof"].(string); ok {
				value := strings.TrimSpace(proof)
				resolve.Proof = &value
			}
			return agentToolsText(stringifyJSON(input.Supervisor.ResolveProblem(resolve)))
		},
		"search_resources": func(id string, params map[string]any) any {
			query := ""
			if raw, ok := params["query"].(string); ok {
				query = strings.TrimSpace(raw)
			}
			if len(query) > 500 {
				panic(errors.New("Capability search query must be at most 500 characters"))
			}
			kind := agentToolsTrimmedString(params["kind"])
			if kind != "" && !agentToolsContains(agentToolsCapabilityKinds, kind) {
				panic(errors.New("Unsupported capability kind"))
			}
			role := agentToolsTrimmedString(params["role"])
			if role != "" && role != "agent" && role != "tool" {
				panic(errors.New("Prompt role must be agent or tool"))
			}
			search := CapabilitySearchInput{}
			if query != "" {
				search.Query = query
			}
			if kind != "" {
				search.Kind = kind
			}
			if role != "" {
				search.Role = role
			}
			if value, ok := agentToolsNumber(params["limit"]); ok {
				search.Limit = int(value)
			}
			if value, ok := agentToolsNumber(params["offset"]); ok {
				search.Offset = int(value)
			}
			result := asMap(input.Catalog.SearchCapabilities(search))
			items := []any{}
			for _, item := range asSlice(result["items"]) {
				items = append(items, agentToolsCapabilityView(asMap(item)))
			}
			view := map[string]any{}
			for key, value := range result {
				view[key] = value
			}
			view["items"] = items
			return agentToolsText(stringifyJSON(view))
		},
		"get_resource": func(id string, params map[string]any) any {
			resourceID, version := agentToolsResourceReference(params["id"], params["version"])
			if resourceID == "" || len(resourceID) > 160 {
				panic(errors.New("A bounded resource id is required"))
			}
			entry := input.Catalog.Capability(resourceID, version)
			if entry == nil {
				hint := " Use the exact id and version returned by search_resources."
				if input.Catalog.AgentCombination(resourceID) != nil {
					hint = ` "` + resourceID + `" is an Agent recipe id; use get_agent_combination instead.`
				}
				message := "Unknown capability " + resourceID
				if version != "" {
					message += "@" + version
				}
				panic(errors.New(message + "." + hint))
			}
			return agentToolsText(stringifyJSON(agentToolsCapabilityView(asMap(entry))))
		},
		"read_system_capabilities": func(id string, params map[string]any) any {
			inventory := input.SystemContext.SystemSummary()
			if os.Getenv("GRAPH_SCOPED_SYSTEM_CAPABILITIES") != "1" {
				return agentToolsText(stringifyJSON(inventory))
			}
			raw, present := params["section"]
			if !present || raw == nil {
				return agentToolsText(stringifyJSON(inventory))
			}
			section, ok := raw.(string)
			if !ok {
				Raise("invalid_input", "Unknown system capability section")
			}
			value, exists := inventory[section]
			if !exists {
				Raise("invalid_input", "Unknown system capability section")
			}
			return agentToolsText(stringifyJSON(map[string]any{section: value}))
		},
		"inspect_graph_system": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.SystemContext.SystemDiagnostics()))
		},
		"propose_system_change": func(id string, params map[string]any) any {
			title := strings.TrimSpace(agentToolsString(params["title"]))
			problem := strings.TrimSpace(agentToolsString(params["problem"]))
			var impact *string
			if raw, ok := params["impact"].(string); ok {
				value := strings.TrimSpace(raw)
				impact = &value
			}
			var risk *string
			if raw, ok := params["risk"].(string); ok {
				value := strings.TrimSpace(raw)
				risk = &value
			}
			if title == "" || len(title) > 200 {
				panic(errors.New("A system-change title of at most 200 characters is required"))
			}
			if problem == "" || len(problem) > 4_000 {
				panic(errors.New("A concrete problem statement of at most 4000 characters is required"))
			}
			if impact != nil && len(*impact) > 2_000 {
				panic(errors.New("System-change impact must be at most 2000 characters"))
			}
			if risk != nil && len(*risk) > 2_000 {
				panic(errors.New("System-change risk must be at most 2000 characters"))
			}
			serialized := agentToolsString(params["changeJson"])
			if strings.TrimSpace(serialized) == "" || len(serialized) > 250_000 {
				panic(errors.New("changeJson must be a bounded JSON document"))
			}
			var change any
			if err := json.Unmarshal([]byte(serialized), &change); err != nil {
				panic(errors.New("changeJson must be a bounded JSON document"))
			}
			record := asMap(change)
			if record == nil {
				panic(errors.New("changeJson must describe one object"))
			}
			return agentToolsText(stringifyJSON(input.SystemContext.ProposeSystemChange(AgentToolsSystemChange{
				Title: title, Problem: problem, Change: record, Impact: impact, Risk: risk,
			})))
		},
		"apply_system_change": func(id string, params map[string]any) any {
			proposalID := strings.TrimSpace(agentToolsString(params["proposalId"]))
			if proposalID == "" || len(proposalID) > 200 {
				panic(errors.New("A bounded proposalId is required"))
			}
			return agentToolsText(stringifyJSON(input.SystemContext.ApplySystemChange(proposalID)))
		},
		"inspect_rsi_status": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Rsi.Status(false)))
		},
		"apply_rsi_change": func(id string, params map[string]any) any {
			title := strings.TrimSpace(agentToolsStringOrEmpty(params["title"]))
			problem := strings.TrimSpace(agentToolsStringOrEmpty(params["problem"]))
			if title == "" || len(title) > 200 {
				panic(errors.New("An RSI title of at most 200 characters is required"))
			}
			if problem == "" || len(problem) > 4_000 {
				panic(errors.New("A concrete RSI problem of at most 4000 characters is required"))
			}
			receipt := input.Rsi.Apply(params, input.RsiContext)
			result := agentToolsText(stringifyJSON(receipt))
			record := asMap(receipt)
			if record != nil {
				status, _ := record["status"].(string)
				restartRequired, _ := record["restartRequired"].(bool)
				if status == "applied" && restartRequired {
					result["terminate"] = true
				}
			}
			return result
		},
		"compare_harness_candidates": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessCompare == nil {
				panic(errors.New("Harness comparison is unavailable in this session"))
			}
			nodeIds := []string{}
			switch typed := params["nodeIds"].(type) {
			case []any:
				for _, item := range typed {
					nodeIds = append(nodeIds, agentToolsString(item))
				}
			case []string:
				nodeIds = append(nodeIds, typed...)
			}
			baseline := ""
			if value, ok := params["baselineNodeId"].(string); ok {
				baseline = strings.TrimSpace(value)
			}
			domain := ""
			if value, ok := params["domain"].(string); ok {
				domain = strings.TrimSpace(value)
			}
			comparison := input.GraphManagement.HarnessCompare(map[string]any{
				"graphId":        agentToolsString(params["graphId"]),
				"nodeIds":        nodeIds,
				"baselineNodeId": baseline,
				"domain":         domain,
			})
			return agentToolsText(stringifyJSON(comparison))
		},
		"record_harness_decision": func(id string, params map[string]any) any {
			requestId := ""
			if value, ok := params["requestId"].(string); ok {
				requestId = strings.TrimSpace(value)
			}
			harness := ""
			if value, ok := params["harness"].(string); ok {
				harness = strings.TrimSpace(value)
			}
			domain := strings.TrimSpace(agentToolsString(params["domain"]))
			axis := harnessAxis(agentToolsStringOrEmpty(params["axis"]))
			// The lessons already adopted in the scope this lesson lands in
			// are the ones it joins, so they are read before it is written.
			entries := []HarnessExperienceEntry{}
			if input.GraphManagement.HarnessExperience != nil {
				existing, ok := input.GraphManagement.HarnessExperience(map[string]any{
					"scope": harnessExperienceScope(domain, axis),
				}).(HarnessExperienceResult)
				if ok {
					entries = existing.Entries
				}
			}
			result := input.GraphManagement.HarnessDecision(&artifacts, entries, HarnessDecisionInput{
				GraphId:   strings.TrimSpace(agentToolsStringOrEmpty(params["graphId"])),
				Domain:    domain,
				Axis:      axis,
				Chosen:    strings.TrimSpace(agentToolsString(params["chosen"])),
				Cue:       strings.TrimSpace(agentToolsString(params["cue"])),
				Lesson:    strings.TrimSpace(agentToolsString(params["lesson"])),
				Evidence:  strings.TrimSpace(agentToolsString(params["evidence"])),
				Harness:   harness,
				RequestId: requestId,
			})
			return agentToolsText(stringifyJSON(result))
		},
		"read_harness_experience": func(id string, params map[string]any) any {
			domain := ""
			if value, ok := params["domain"].(string); ok {
				domain = strings.TrimSpace(value)
			}
			if input.GraphManagement.HarnessExperience == nil {
				return agentToolsText(stringifyJSON(HarnessExperienceResult{}))
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.HarnessExperience(map[string]any{"domain": domain})))
		},
		"read_harness_evidence": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessEvidence == nil {
				panic(errors.New("Reading harness evidence is unavailable in this session"))
			}
			limit := 0
			if value, ok := agentToolsNumber(params["limit"]); ok {
				limit = int(value)
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.HarnessEvidence(HarnessEvidenceInput{
				GraphId: agentToolsStringOrEmpty(params["graphId"]),
				NodeId:  agentToolsStringOrEmpty(params["nodeId"]),
				Kind:    agentToolsStringOrEmpty(params["kind"]),
				Limit:   limit,
			})))
		},
		"probe_harness": func(id string, params map[string]any) any {
			if input.GraphManagement.HarnessProbe == nil {
				panic(errors.New("Harness probing is unavailable in this session"))
			}
			variants, err := agentToolsHarnessVariants(params["variants"])
			if err != nil {
				panic(err)
			}
			timeout := 0
			if value, ok := agentToolsNumber(params["timeoutMs"]); ok {
				timeout = int(value)
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.HarnessProbe(HarnessProbeInput{
				Task:      agentToolsStringOrEmpty(params["task"]),
				Recipe:    agentToolsStringOrEmpty(params["recipe"]),
				Model:     agentToolsStringOrEmpty(params["model"]),
				Variants:  variants,
				Domain:    agentToolsStringOrEmpty(params["domain"]),
				TimeoutMs: timeout,
			})))
		},
		"ask_user": func(id string, params map[string]any) any {
			prompt := strings.TrimSpace(agentToolsStringOrEmpty(params["prompt"]))
			why := strings.TrimSpace(agentToolsStringOrEmpty(params["why"]))
			if prompt == "" {
				panic(errors.New("A question is required"))
			}
			if why == "" {
				panic(errors.New("Say what would change with the answer: a question nobody can act on is not worth the user turn"))
			}
			if input.OnAskUser == nil {
				panic(errors.New("This Agent session cannot ask the user"))
			}
			options := []string{}
			if raw, ok := params["options"].([]any); ok {
				for _, item := range raw {
					value := strings.TrimSpace(agentToolsString(item))
					if value == "" {
						continue
					}
					if len(value) > 300 {
						value = value[:300]
					}
					if !agentToolsContains(options, value) {
						options = append(options, value)
					}
				}
				if len(options) > 8 {
					options = options[:8]
				}
			}
			input.OnAskUser(PiAdapterAskedQuestion{
				Prompt: agentToolsTruncate(prompt, 2_000), Why: agentToolsTruncate(why, 1_000),
				Options: options, Multiple: params["multiple"] == true,
			})
			// The turn stops here on purpose: the answer is the next turn's input.
			result := agentToolsText(stringifyJSON(map[string]any{"status": "asked", "prompt": prompt}))
			result["terminate"] = true
			return result
		},
		"conversation_read": func(id string, params map[string]any) any {
			if input.Conversations.List == nil {
				panic(errors.New("This Agent session cannot reach other conversations"))
			}
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			if action == "list" {
				var archived *bool
				if value, ok := params["archived"].(bool); ok && value {
					archived = &value
				}
				return agentToolsText(stringifyJSON(input.Conversations.List(archived)))
			}
			conversationID := strings.TrimSpace(agentToolsStringOrEmpty(params["conversationId"]))
			if conversationID == "" {
				panic(errors.New("conversationId is required for read and follow"))
			}
			if action == "read" {
				return agentToolsText(stringifyJSON(input.Conversations.Read(conversationID,
					agentToolsBoundedNumber(params["limit"], 50), agentToolsBoundedNumber(params["after"], 0))))
			}
			if action == "follow" {
				return agentToolsText(stringifyJSON(input.Conversations.Follow(conversationID,
					agentToolsBoundedNumber(params["after"], 0), agentToolsBoundedNumber(params["limit"], 100))))
			}
			panic(errors.New("Unsupported read action: use list, read or follow"))
		},
		"conversation_write": func(id string, params map[string]any) any {
			if input.Conversations.Send == nil {
				panic(errors.New("This Agent session cannot reach other conversations"))
			}
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			conversationID := strings.TrimSpace(agentToolsStringOrEmpty(params["conversationId"]))
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if conversationID == "" {
				panic(errors.New("conversationId is required"))
			}
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			if action == "send" || action == "steer" {
				message := strings.TrimSpace(agentToolsStringOrEmpty(params["text"]))
				if message == "" {
					panic(errors.New("text is required for " + action))
				}
				if action == "send" {
					return agentToolsText(stringifyJSON(input.Conversations.Send(conversationID, message, requestID)))
				}
				return agentToolsText(stringifyJSON(input.Conversations.Steer(conversationID, message, requestID)))
			}
			if action == "pause" {
				return agentToolsText(stringifyJSON(input.Conversations.Pause(conversationID, requestID)))
			}
			if action == "resume" {
				return agentToolsText(stringifyJSON(input.Conversations.Resume(conversationID, requestID)))
			}
			panic(errors.New("Unsupported write action: use send, steer, pause or resume"))
		},
		"control_task": func(id string, params map[string]any) any {
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			if !agentToolsContains(agentToolsControlActions, action) {
				panic(errors.New("Unsupported control action: use pause, resume, abandon, set_budget or steer"))
			}
			if input.ControlTask == nil {
				panic(errors.New("This Agent session cannot control tasks"))
			}
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			control := AgentToolsControlTask{Action: action, RequestId: requestID}
			if raw, ok := params["taskId"].(string); ok && strings.TrimSpace(raw) != "" {
				value := strings.TrimSpace(raw)
				control.TaskId = &value
			}
			if raw, ok := params["nodeId"].(string); ok && strings.TrimSpace(raw) != "" {
				value := strings.TrimSpace(raw)
				control.NodeId = &value
			}
			if raw, ok := params["text"].(string); ok {
				value := raw
				control.Text = &value
			}
			if raw, present := params["tokens"]; present {
				if raw == nil {
					control.Tokens = nil
				} else if value, ok := agentToolsNumber(raw); ok {
					tokens := int(value)
					control.Tokens = &tokens
				}
			}
			if raw, ok := params["reason"].(string); ok {
				value := raw
				control.Reason = &value
			}
			receipt := input.ControlTask(control)
			result := agentToolsText(stringifyJSON(receipt))
			// Abandoning ends the task, so there is nothing left to continue in this turn.
			if action == "abandon" {
				result["terminate"] = true
			}
			return result
		},
		"list_peers": func(id string, params map[string]any) any {
			if peers == nil {
				panic(errors.New("This Agent session has no graph peers"))
			}
			return agentToolsText(stringifyJSON(map[string]any{"peers": peers.list()}))
		},
		"send_to_peer": func(id string, params map[string]any) any {
			if peers == nil {
				panic(errors.New("This Agent session has no graph peers"))
			}
			to := strings.TrimSpace(agentToolsStringOrEmpty(params["to"]))
			message := strings.TrimSpace(agentToolsStringOrEmpty(params["text"]))
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if to == "" {
				panic(errors.New("to is required: name a peer node id (list_peers shows them)"))
			}
			if message == "" {
				panic(errors.New("text is required"))
			}
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			return agentToolsText(stringifyJSON(peers.send(PiAdapterPeerRequest{
				To: to, Text: message, RequestId: requestID,
			})))
		},
		"list_agent_combinations": func(id string, params map[string]any) any {
			query := ""
			if raw, ok := params["query"].(string); ok {
				query = strings.ToLower(strings.TrimSpace(raw))
			}
			if len(query) > 200 {
				panic(errors.New("Agent combination query must be at most 200 characters"))
			}
			grade := ""
			if raw, ok := params["grade"].(string); ok {
				grade = strings.TrimSpace(raw)
			}
			if grade != "" && !agentToolsHasModelGrade(grade) {
				panic(errors.New("Unsupported model grade"))
			}
			limit := 30
			if value, ok := agentToolsNumber(params["limit"]); ok && value > 0 {
				limit = int(value)
				if limit > 50 {
					limit = 50
				}
			}
			search := AgentCombinationSearchInput{}
			if query != "" {
				search.Query = query
			}
			if grade != "" {
				search.Grade = ModelGrade(grade)
			}
			search.Limit = limit
			return agentToolsText(stringifyJSON(input.Catalog.SearchAgentCombinations(search)))
		},
		"get_agent_combination": func(id string, params map[string]any) any {
			combinationID := strings.TrimSpace(agentToolsString(params["id"]))
			if combinationID == "" || len(combinationID) > 160 {
				panic(errors.New("A bounded Agent combination id is required"))
			}
			combination := input.Catalog.AgentCombination(combinationID)
			if combination == nil {
				hint := " Use list_agent_combinations to discover available recipe ids."
				if match := agentToolsVersionedID.FindStringSubmatch(combinationID); match != nil {
					recipe := input.Catalog.AgentCombination(match[1])
					if recipe != nil {
						hint = " Use get_agent_combination(" + stringifyJSON(map[string]any{"id": recipe.Id}) +
							") for current recipe details. A graph node's recipe field uses a versioned definition reference; this lookup takes the stable recipe id and does not resolve historical definitions."
					}
				}
				panic(errors.New("Unknown Agent combination " + combinationID + "." + hint))
			}
			return agentToolsText(stringifyJSON(combination))
		},
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

// agentToolsSupervisorPresent reports whether one session has a supervisor at all.
func agentToolsSupervisorPresent(supervisor PiAdapterSupervisor) bool {
	return supervisor.Propose != nil || supervisor.WithdrawDraft != nil || supervisor.ConfirmDraft != nil ||
		supervisor.ArchiveDraft != nil || supervisor.RestoreDraft != nil || supervisor.DeleteDraft != nil ||
		supervisor.GraphState != nil || supervisor.TaskStatus != nil || supervisor.ValidateProposal != nil ||
		supervisor.ListProjects != nil || supervisor.BindProject != nil || supervisor.ListProblems != nil ||
		supervisor.ResolveProblem != nil
}

// agentToolsArtifacts is the normalized artifact surface of one session.
type agentToolsArtifacts struct {
	present bool
	access  AgentArtifactAccess
	list    func(query ArtifactQuery) ArtifactPage
	get     func(artifactId string, version *int) ArtifactRecord
	read    func(artifactId string, version int, maxBytes int) ArtifactRead
	publish func(input PublishArtifactInput) ArtifactRecord
	retire  func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	promote func(input ArtifactPromoteInput) ArtifactRecord
}

// agentToolsArtifactsOf normalizes the artifact surface of one session.
func agentToolsArtifactsOf(value any) agentToolsArtifacts {
	switch service := value.(type) {
	case *PiAdapterArtifactService:
		access := AgentArtifactAccess{}
		if granted, ok := service.Access.(AgentArtifactAccess); ok {
			access = granted
		}
		return agentToolsArtifacts{
			present: true, access: access,
			list:    service.List,
			get:     service.Get,
			read:    service.Read,
			publish: service.Publish,
			retire:  service.Retire,
			promote: service.Promote,
		}
	case *AgentToolsArtifactService:
		return agentToolsArtifacts{
			present: true,
			access:  AgentArtifactAccess{AllowedNamespaces: service.AllowedNamespaces, CanPromote: service.CanPromote},
			list:    service.List,
			get:     service.Get,
			read:    service.Read,
			publish: service.Publish,
			retire:  service.Retire,
			promote: service.Promote,
		}
	}
	return agentToolsArtifacts{}
}

// agentToolsPeers is the normalized peer surface of one session.
type agentToolsPeers struct {
	list func() []PiAdapterPeerNode
	send func(request PiAdapterPeerRequest) any
}

// agentToolsPeersOf normalizes the peer surface of one session.
func agentToolsPeersOf(value any) *agentToolsPeers {
	switch service := value.(type) {
	case PiAdapterPeerTools:
		return &agentToolsPeers{list: service.List, send: service.Send}
	case *PiAdapterPeerTools:
		return &agentToolsPeers{list: service.List, send: service.Send}
	}
	return nil
}

// agentToolsText is a text tool result.
func agentToolsText(value string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": value}},
		"details": map[string]any{},
	}
}

// agentToolsImage is an image tool result.
func agentToolsImage(data []byte, mimeType string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{
			"type": "image", "data": base64.StdEncoding.EncodeToString(data), "mimeType": mimeType,
		}},
		"details": map[string]any{},
	}
}

// agentToolsParams is the argument object of one tool call.
func agentToolsParams(raw any) map[string]any {
	params, _ := raw.(map[string]any)
	if params == nil {
		return map[string]any{}
	}
	return params
}

// agentToolsImageMimeType is the image type of one path, if it is an image.
func agentToolsImageMimeType(path string) string {
	return agentToolsImageMimeTypes[strings.ToLower(filepath.Ext(path))]
}

// agentToolsMount is the granted root one absolute path belongs to.
func agentToolsMount(candidates []string, requested string) string {
	for _, candidate := range candidates {
		if requested == candidate || strings.HasPrefix(requested, candidate+string(os.PathSeparator)) {
			return candidate
		}
	}
	return ""
}

// agentToolsCommandOutput is the text of one command result.
func agentToolsCommandOutput(result CommandResult) string {
	code := "signal"
	if result.Code != nil {
		code = itoa(*result.Code)
	}
	return "exit " + code + "\n" + result.Stdout + result.Stderr
}

// agentToolsGitText runs one read-only git command and returns its output.
func agentToolsGitText(input AgentToolsInput, args []string, path string) string {
	full := append([]string{}, args...)
	if path != "" {
		full = append(full, "--", path)
	}
	result := input.Run("git", full, nil)
	return agentToolsCommandOutput(result)
}

// agentToolsNativeProposal is the native proposal of one tool call.
func agentToolsNativeProposal(value any) NativeProposal {
	record := asMap(value)
	if record == nil {
		Raise("invalid_proposal", "Expected a native proposal object with definition; use schemaVersion:2 graph JSON")
	}
	if _, exists := record["definition"]; !exists {
		Raise("invalid_proposal", "Expected a native proposal object with definition; use schemaVersion:2 graph JSON")
	}
	raw, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	var proposal NativeProposal
	if err := json.Unmarshal(raw, &proposal); err != nil {
		panic(err)
	}
	return proposal
}

// agentToolsResourceReference is the id and version of one resource reference.
func agentToolsResourceReference(rawID, explicitVersion any) (string, string) {
	id := strings.TrimSpace(agentToolsStringOrEmpty(rawID))
	version := ""
	if text, ok := explicitVersion.(string); ok && strings.TrimSpace(text) != "" {
		version = strings.TrimSpace(text)
	}
	separator := strings.LastIndex(id, "@")
	if separator > 0 && separator < len(id)-1 {
		embedded := strings.TrimSpace(id[separator+1:])
		if version != "" && version != embedded {
			panic(errors.New("Conflicting versions for capability " + id[:separator]))
		}
		version = embedded
		id = id[:separator]
	}
	return id, version
}

// agentToolsCapabilityView is the resource view the resource tools return.
func agentToolsCapabilityView(record map[string]any) map[string]any {
	if record == nil {
		record = map[string]any{}
	}
	id := mapString(record, "id", "Id")
	name := mapString(record, "name", "Name")
	if name == "" {
		name = id
	}
	description := mapString(record, "description", "Description")
	view := map[string]any{
		"id": id, "kind": mapString(record, "kind", "Kind"), "version": mapString(record, "version", "Version"),
		"name": name, "description": description, "source": mapString(record, "source", "Source"),
		"status": mapString(record, "status", "Status"), "grantsNoPermission": true,
	}
	if role := mapString(record, "role", "Role"); role != "" {
		view["role"] = role
	}
	if failure := mapString(record, "error", "Error"); failure != "" {
		view["error"] = failure
	}
	return view
}

// agentToolsGraphSectionQuery is the frozen definition read of one tool call.
func agentToolsGraphSectionQuery(params map[string]any) GraphSectionQuery {
	query := GraphSectionQuery{Section: agentToolsString(params["section"])}
	if raw, ok := params["id"].(string); ok {
		value := raw
		query.Id = &value
	}
	if value, ok := agentToolsNumber(params["after"]); ok {
		after := int(value)
		query.After = &after
	}
	if value, ok := agentToolsNumber(params["limit"]); ok {
		limit := int(value)
		query.Limit = &limit
	}
	return query
}

// agentToolsHarnessVariants reads the variant list of a harness probe.
func agentToolsHarnessVariants(value any) ([]HarnessProbeVariant, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, errors.New("variants must be a list of probe variants")
	}
	out := []HarnessProbeVariant{}
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("every probe variant must be an object with a label")
		}
		variant := HarnessProbeVariant{
			Label:   agentToolsStringOrEmpty(record["label"]),
			Axis:    agentToolsStringOrEmpty(record["axis"]),
			Recipe:  agentToolsStringOrEmpty(record["recipe"]),
			Model:   agentToolsStringOrEmpty(record["model"]),
			Harness: map[string]string{},
		}
		if raw, present := record["harness"]; present && raw != nil {
			harness, ok := raw.(map[string]any)
			if !ok {
				return nil, errors.New("a probe variant harness must be an object of prompt key to text")
			}
			for key, text := range harness {
				content, ok := text.(string)
				if !ok {
					return nil, errors.New("a probe variant harness value must be a string")
				}
				variant.Harness[key] = content
			}
		}
		out = append(out, variant)
	}
	return out, nil
}

// agentToolsOptionalString is one trimmed string argument, or none.
func agentToolsOptionalString(params map[string]any, key string) *string {
	raw, ok := params[key].(string)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// agentToolsTrimmedString is one trimmed string argument, or the empty string.
func agentToolsTrimmedString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// agentToolsBoundedNumber is one non-negative integer argument, or the fallback.
func agentToolsBoundedNumber(value any, fallback int) int {
	number, ok := agentToolsNumber(value)
	if !ok {
		return fallback
	}
	if number < 0 {
		return 0
	}
	return int(number)
}

// agentToolsNumber is one finite number argument.
func agentToolsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != typed {
			return 0, false
		}
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return number, true
	}
	return 0, false
}

// agentToolsNumberValue is the JavaScript Number() conversion of one argument.
func agentToolsNumberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, true
		}
		number, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, false
		}
		return number, true
	}
	return agentToolsNumber(value)
}

// agentToolsTruthy reports whether one argument is truthy in JavaScript.
func agentToolsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && typed == typed
	case float32:
		return typed != 0
	case int:
		return typed != 0
	case int64:
		return typed != 0
	}
	return true
}

// agentToolsStringOrEmpty is the String() conversion of one argument, with a
// missing argument read as the empty string.
func agentToolsStringOrEmpty(value any) string {
	if value == nil {
		return ""
	}
	return agentToolsString(value)
}

// agentToolsString is the String() conversion of one argument.
func agentToolsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "undefined"
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case int:
		return itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case json.Number:
		return typed.String()
	}
	return stringifyJSON(value)
}

// agentToolsUnique removes duplicates and keeps the order.
func agentToolsUnique(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// agentToolsHasModelGrade reports whether one grade is a known model grade.
func agentToolsHasModelGrade(grade string) bool {
	for _, value := range MODEL_GRADES {
		if string(value) == grade {
			return true
		}
	}
	return false
}

// agentToolsContains reports whether one list holds a value.
func agentToolsContains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// agentToolsTruncate cuts a string to at most the given number of characters.
func agentToolsTruncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
