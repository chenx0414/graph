package graph

import (
	"fmt"
	"sort"
	"strings"

	"encoding/json"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

type FrozenExecution struct {
	Identity string `json:"identity"`
	ExecutionId string `json:"executionId"`
	InputRequestId string `json:"inputRequestId"`
	PreAdmissionInvocationIds []string `json:"preAdmissionInvocationIds"`
	Model any `json:"model"`
	Agent FrozenExecutionAgent `json:"agent"`
	ExtensionName string `json:"extensionName"`
	Tools []FrozenExecutionTool `json:"tools"`
	Policy FrozenExecutionPolicy `json:"policy"`
	Configuration FrozenExecutionConfiguration `json:"configuration"`
}

type FrozenExecutionAgent struct {
	Model any `json:"model"`
	Instructions string `json:"instructions"`
	Cwd string `json:"cwd"`
}

type FrozenExecutionTool struct {
	Name string `json:"name"`
	Description string `json:"description"`
	Parameters any `json:"parameters"`
}

type FrozenExecutionConfiguration struct {
	ExecutionConfiguration any `json:"executionConfiguration"`
	CredentialReference any `json:"credentialReference"`
	HeaderCredentials []string `json:"headerCredentials"`
	Descriptor any `json:"descriptor"`
}

type FrozenExecutionPolicy struct {
	Workspace string `json:"workspace"`
	StateDir string `json:"stateDir"`
	SkillPaths []string `json:"skillPaths"`
	SkillFolder string `json:"skillFolder"`
	PiExtensionPaths []string `json:"piExtensionPaths"`
	ReadRoots []string `json:"readRoots"`
	WriteRoots []string `json:"writeRoots"`
	ProtectedPaths []string `json:"protectedPaths"`
	FilesystemAccess string `json:"filesystemAccess"`
	NativeTools []string `json:"nativeTools"`
	AllowedToolNames []string `json:"allowedToolNames"`
	PiExtensionTools []string `json:"piExtensionTools"`
	BundleDigest string `json:"bundleDigest"`
	ToolPolicyDigest string `json:"toolPolicyDigest"`
	RuntimePolicyDigest string `json:"runtimePolicyDigest"`
	ThinkingLevel *string `json:"thinkingLevel"`
}

type FrozenExecutionRecovery struct {
	Record FrozenExecution
	Descriptor map[string]any
	Identity string
}

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

func frozenExecutionRecovery(frozen FrozenExecution, identity string) *FrozenExecutionRecovery {
	descriptor := map[string]any{}
	if value := asMap(frozen.Configuration.Descriptor); value != nil {
		descriptor = value
	}
	return &FrozenExecutionRecovery{Record: frozen, Descriptor: descriptor, Identity: identity}
}

func isCredentialHeader(name string) bool {
	key := strings.ToLower(name)
	return key == "authorization" || key == "proxy-authorization" || key == "cookie" || key == "set-cookie" ||
		key == "x-api-key" || key == "api-key" ||
		strings.HasSuffix(key, "token") || strings.HasSuffix(key, "secret") || strings.HasSuffix(key, "password")
}

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
