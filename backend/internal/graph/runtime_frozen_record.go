package graph

import (
	"fmt"
	"sort"
	"strings"

	"encoding/json"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// FrozenExecution is the durable record of one execution.
//
// It is what the recovery reads after a crash: which execution the kernel
// was running, the model it was admitted with and the input it was waiting
// for.
//
// The record is durable, so the field names below are the on-disk format.
// They do not change, and a record written by an older daemon still reads.
type FrozenExecution struct {
	// Identity is the session identity the execution belonged to.
	Identity string `json:"identity"`
	// ExecutionId is the Graph execution the record describes.
	ExecutionId string `json:"executionId"`
	// InputRequestId is the admission identity of the input.
	InputRequestId string `json:"inputRequestId"`
	// PreAdmissionInvocationIds are the invocations the kernel recorded
	// before it admitted the input.
	PreAdmissionInvocationIds []string `json:"preAdmissionInvocationIds"`
	// Model is the provider model the execution was admitted with.
	Model any `json:"model"`
	// Agent is the agent the execution ran.
	Agent FrozenExecutionAgent `json:"agent"`
	// ExtensionName is the Pi extension the session hosted.
	ExtensionName string `json:"extensionName"`
	// Tools are the tools the session offered the model.
	Tools []FrozenExecutionTool `json:"tools"`
	// Policy is the policy the execution was admitted with.
	Policy FrozenExecutionPolicy `json:"policy"`
	// Configuration is the configuration the execution carried.
	Configuration FrozenExecutionConfiguration `json:"configuration"`
}

// FrozenExecutionAgent is the agent one frozen execution ran.
type FrozenExecutionAgent struct {
	// Model is the provider model the agent ran on.
	Model any `json:"model"`
	// Instructions is the system prompt the agent ran with.
	Instructions string `json:"instructions"`
	// Cwd is the working directory the agent ran in.
	Cwd string `json:"cwd"`
}

// FrozenExecutionTool is one tool the frozen session offered the model.
type FrozenExecutionTool struct {
	// Name is the tool name the model calls.
	Name string `json:"name"`
	// Description is the tool description the model saw.
	Description string `json:"description"`
	// Parameters is the tool schema the model saw.
	Parameters any `json:"parameters"`
}

// FrozenExecutionConfiguration is the configuration one frozen execution
// carried.
type FrozenExecutionConfiguration struct {
	// ExecutionConfiguration is the execution configuration the session ran
	// with.
	ExecutionConfiguration any `json:"executionConfiguration"`
	// CredentialReference names the credential the session was bound to.
	CredentialReference any `json:"credentialReference"`
	// HeaderCredentials are the credential header names the session may
	// restore. The values stay with the daemon's live binding.
	HeaderCredentials []string `json:"headerCredentials"`
	// Descriptor is the capability descriptor the session carried.
	Descriptor any `json:"descriptor"`
}

// FrozenExecutionPolicy is the policy one execution was admitted with.
//
// The recovery replays an execution with this policy and not with the policy
// of the moment, so the fields here are the fields a recovered turn may read.
type FrozenExecutionPolicy struct {
	// Workspace is the work copy the execution ran in.
	Workspace string `json:"workspace"`
	// StateDir is the instance directory of the execution.
	StateDir string `json:"stateDir"`
	// SkillPaths are the skills the execution could read.
	SkillPaths []string `json:"skillPaths"`
	// SkillFolder is the agent's own skills folder.
	SkillFolder string `json:"skillFolder"`
	// PiExtensionPaths are the Pi extensions the execution loaded.
	PiExtensionPaths []string `json:"piExtensionPaths"`
	// ReadRoots are the directories beside the workspace it could read.
	ReadRoots []string `json:"readRoots"`
	// WriteRoots are the directories it could write.
	WriteRoots []string `json:"writeRoots"`
	// ProtectedPaths are the paths the host protected.
	ProtectedPaths []string `json:"protectedPaths"`
	// FilesystemAccess is bounded or host.
	FilesystemAccess string `json:"filesystemAccess"`
	// NativeTools are the Pi native tools it could call.
	NativeTools []string `json:"nativeTools"`
	// AllowedToolNames are the tools it could call.
	AllowedToolNames []string `json:"allowedToolNames"`
	// PiExtensionTools are the tools its Pi extensions registered for it.
	PiExtensionTools []string `json:"piExtensionTools"`
	// BundleDigest is the capability bundle digest of the execution.
	BundleDigest string `json:"bundleDigest"`
	// ToolPolicyDigest is the tool policy digest of the execution.
	ToolPolicyDigest string `json:"toolPolicyDigest"`
	// RuntimePolicyDigest is the runtime policy digest of the execution.
	RuntimePolicyDigest string `json:"runtimePolicyDigest"`
	// ThinkingLevel is the reasoning strength the execution asked for.
	ThinkingLevel *string `json:"thinkingLevel"`
}

// FrozenExecutionRecovery is what a recovered execution hands back.
//
// The adapter replays a main turn with it and the node lane replays a node
// turn with it. Both read the same record, so there is one definition of
// what a recovered execution holds.
type FrozenExecutionRecovery struct {
	// Record is the durable record of the execution.
	Record FrozenExecution
	// Descriptor is the capability descriptor the execution carried.
	Descriptor map[string]any
	// Identity is the session identity the kernel reported for the frozen
	// execution. The record has to belong to that identity.
	Identity string
}

// frozenExecutionOfRequest builds the durable record of one request.
//
// The credential headers never enter the record: the daemon owns the live
// binding, and the record only names the headers it may restore.
func frozenExecutionOfRequest(request AgentSessionRequest, preAdmission []string) FrozenExecution {
	model := map[string]any{}
	if view, ok := request.Model.(piModelView); ok {
		body, _ := json.Marshal(view)
		_ = json.Unmarshal(body, &model)
	} else if record := asMap(request.Model); record != nil {
		model = record
	}
	configuration := map[string]any{}
	if request.ExecutionConfiguration != nil {
		body, _ := json.Marshal(request.ExecutionConfiguration)
		_ = json.Unmarshal(body, &configuration)
	}
	credential := map[string]any{}
	if request.CredentialReference != nil {
		body, _ := json.Marshal(request.CredentialReference)
		_ = json.Unmarshal(body, &credential)
	}
	names := map[string]bool{}
	for _, header := range []map[string]any{model, pigNestedMap(configuration, "model")} {
		for _, name := range pigCredentialHeaders(header) {
			names[name] = true
		}
	}
	credentials := []string{}
	for name := range names {
		credentials = append(credentials, name)
	}
	sort.Strings(credentials)
	tools := []FrozenExecutionTool{}
	for _, tool := range request.Tools {
		tools = append(tools, FrozenExecutionTool{Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters})
	}
	return FrozenExecution{
		Identity: request.Binding.InstanceId, ExecutionId: request.ExecutionId, InputRequestId: request.InputRequestId,
		PreAdmissionInvocationIds: preAdmission, Model: model,
		Agent:         FrozenExecutionAgent{Model: model, Instructions: request.SystemPrompt, Cwd: request.Workspace},
		ExtensionName: pigkernel.ExtensionName(request.Binding.InstanceId),
		Tools:         tools,
		Policy: FrozenExecutionPolicy{
			Workspace: request.Workspace, StateDir: request.StateDir, SkillPaths: request.SkillPaths,
			SkillFolder: request.SkillFolder, PiExtensionPaths: request.PiExtensionPaths, ReadRoots: request.ReadRoots,
			WriteRoots: request.WriteRoots, ProtectedPaths: request.ProtectedPaths, FilesystemAccess: request.FilesystemAccess,
			NativeTools: request.NativeTools, AllowedToolNames: request.AllowedToolNames,
			PiExtensionTools: request.PiExtensionTools, BundleDigest: request.BundleDigest,
			ToolPolicyDigest: request.ToolPolicyDigest, RuntimePolicyDigest: request.RuntimePolicyDigest, ThinkingLevel: request.ThinkingLevel,
		},
		Configuration: FrozenExecutionConfiguration{
			ExecutionConfiguration: configuration, CredentialReference: credential,
			HeaderCredentials: credentials, Descriptor: request.CapabilityDescriptor,
		},
	}
}

// frozenExecutionRecord is the durable form of one record.
func frozenExecutionRecord(frozen FrozenExecution) map[string]any {
	body, err := json.Marshal(frozen)
	if err != nil {
		panic(err)
	}
	record := map[string]any{}
	if err := json.Unmarshal(body, &record); err != nil {
		panic(err)
	}
	return record
}

// frozenExecutionOfRecord reads a durable record back.
func frozenExecutionOfRecord(record map[string]any) FrozenExecution {
	body, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	var frozen FrozenExecution
	if err := json.Unmarshal(body, &frozen); err != nil {
		panic(err)
	}
	return frozen
}

// frozenExecutionRecovery is what a recovered execution hands back.
func frozenExecutionRecovery(frozen FrozenExecution, identity string) *FrozenExecutionRecovery {
	descriptor := map[string]any{}
	if value := asMap(frozen.Configuration.Descriptor); value != nil {
		descriptor = value
	}
	return &FrozenExecutionRecovery{Record: frozen, Descriptor: descriptor, Identity: identity}
}

// isCredentialHeader reports whether one header carries a credential.
//
// A credential never belongs in a durable record: the record outlives the
// process that wrote it, and the daemon keeps the live binding.
func isCredentialHeader(name string) bool {
	key := strings.ToLower(name)
	return key == "authorization" || key == "proxy-authorization" || key == "cookie" || key == "set-cookie" ||
		key == "x-api-key" || key == "api-key" ||
		strings.HasSuffix(key, "token") || strings.HasSuffix(key, "secret") || strings.HasSuffix(key, "password")
}

// restoreDurableModelHeaders restores the credential headers of a recovered
// turn.
//
// The frozen record names the headers the turn was admitted with; the values
// come from the daemon's live binding. A header that is gone is a refusal:
// the turn cannot be sent again with a credential it no longer has.
func restoreDurableModelHeaders(configuration FrozenExecutionConfiguration, model *ModelEntry, directory []ModelEntry) {
	names := configuration.HeaderCredentials
	for _, name := range names {
		found := false
		for _, entry := range directory {
			if entry.Id != model.Id {
				continue
			}
			for key, value := range ModelRequestHeaders(entry) {
				if strings.EqualFold(key, name) {
					if model.Headers == nil {
						model.Headers = map[string]string{}
					}
					model.Headers[name] = value
					found = true
					break
				}
			}
		}
		if !found {
			panic(fmt.Errorf("Original credential header %s is unavailable for model %s", name, model.Id))
		}
	}
}
