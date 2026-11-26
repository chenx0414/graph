package graph

import (
	"encoding/json"
	"strings"
	"sync"

	"github.com/chenx0414/graph/backend/internal/agentcore"
)

const PI_SESSION_RESERVE = 2_000_000

const CONVERSATION_DELTA_FLUSH_MS = 60

const PROMPT_SUGGESTION_TIMEOUT_MS = 5_000

type PiAdapterOptions struct {
	RecoverySnapshot  *FrozenExecutionRecovery
	Store             *TaskStore
	InstancesDir      string
	Catalog           *Catalog
	Artifacts         *ArtifactWorkspace
	Directory         func() []ModelEntry
	ApiKey            *string
	ApiKeyFor         func(entry ModelEntry) *string
	BindingFor        func(entry ModelEntry) *PiAdapterBinding
	Scheduler         *ModelScheduler
	ModelRuntime      *ModelRuntime
	Network           *PiAdapterNetwork
	TaskSetups        *TaskSetupLedger
	CapabilitySecrets func() map[string]string
	Channels          *PiAdapterChannels
	Transport         AgentSessionTransport
	SpawnAgent        func(parent AgentSpawnParent, input AgentSpawnInput) any
	ControlAgent      func(parent AgentSpawnParent, input AgentControlInput) any
	DaemonNativeTools bool
}

func CreatePiAdapter(options PiAdapterOptions) ActionAdapter {
	reserve := PI_SESSION_RESERVE
	transport := options.Transport
	if transport == nil {
		transport = CreatePigAgentSessionTransport(options.Store, CodemodeSettings{})
	}
	activeInstances := map[string]*agentcore.Agent{}
	activeInstancesMu := sync.Mutex{}
	turnOrdinals := map[string]func() int{}
	turnOrdinalsMu := sync.Mutex{}
	interruptSignals := map[string]*AbortSignal{}
	interruptSignalsMu := sync.Mutex{}
	signalFor := func(operationId string) *AbortSignal {
		interruptSignalsMu.Lock()
		defer interruptSignalsMu.Unlock()
		signal := interruptSignals[operationId]
		if signal == nil {
			signal = NewAbortSignal()
			interruptSignals[operationId] = signal
		}
		return signal
	}
	dropSignal := func(operationId string) {
		interruptSignalsMu.Lock()
		delete(interruptSignals, operationId)
		interruptSignalsMu.Unlock()
	}
	systemChangeApplications := map[string]*piAdapterPending{}
	systemChangeApplicationsMu := sync.Mutex{}

	adapter := ActionAdapter{
		Kind:          "agent",
		ReserveTokens: &reserve,
	}
	adapter.CanReplayBeforeSend = func(store *TaskStore, operation Operation) bool {
		db := options.Store.Db
		if store != nil {
			db = store.Db
		}
		capability, _ := graphDBRow(db, "SELECT 1 FROM node_capabilities WHERE operation_id=? LIMIT 1", operation.Id)
		invocation, _ := graphDBRow(db, "SELECT 1 FROM invocations WHERE operation_id=? LIMIT 1", operation.Id)
		return capability == nil && invocation == nil
	}
	adapter.Steer = func(operation Operation, text string) any {
		activeInstancesMu.Lock()
		active := activeInstances[operation.Id]
		activeInstancesMu.Unlock()
		if active == nil {
			Raise("no_active_operation", "The master Agent is no longer accepting steering messages")
		}
		if err := active.Steer(text); err != nil {
			panic(err)
		}
		turnOrdinalsMu.Lock()
		allocate := turnOrdinals[operation.Id]
		turnOrdinalsMu.Unlock()
		if allocate == nil {
			return map[string]any{}
		}
		return map[string]any{"ordinal": allocate()}
	}
	adapter.Interrupt = func(operation Operation, text *string) any {
		activeInstancesMu.Lock()
		active := activeInstances[operation.Id]
		activeInstancesMu.Unlock()
		if active == nil {
			Raise("no_active_operation", "The master Agent is no longer accepting interruption")
		}
		interrupting := text == nil || *text == ""
		interruptSignalsMu.Lock()
		signal := interruptSignals[operation.Id]
		interruptSignalsMu.Unlock()
		if err := active.Interrupt(text); err != nil {
			if strings.Contains(err.Error(), "no longer accepting") || strings.Contains(err.Error(), "session is closed") {
				Raise("no_active_operation", "The master Agent is no longer accepting interruption")
			}
			panic(err)
		}
		if interrupting {
			signal.Abort()
		}
		if text == nil || *text == "" {
			return map[string]any{}
		}
		turnOrdinalsMu.Lock()
		allocate := turnOrdinals[operation.Id]
		turnOrdinalsMu.Unlock()
		if allocate == nil {
			return map[string]any{}
		}
		return map[string]any{"ordinal": allocate()}
	}
	adapter.Stop = func(operation Operation) {
		activeInstancesMu.Lock()
		active := activeInstances[operation.Id]
		activeInstancesMu.Unlock()
		if active == nil {
			return
		}
		if err := active.Stop(); err != nil {
			panic(err)
		}
	}
	adapter.Prepare = func(operation Operation) func() OperationResult {
		if operation.InstanceId == nil {
			Raise("invalid_adapter", "Agents require an instance")
		}
		instance, ok := graphDBRow(options.Store.Db, "SELECT definition_version,model FROM instances WHERE id=?", *operation.InstanceId)
		if !ok {
			Raise("model_unavailable", "No configured model for this instance")
		}
		definitionVersion := graphDBStringPtr(instance, "definition_version")
		modelId := graphDBStringPtr(instance, "model")
		var entry *ModelEntry
		for _, candidate := range options.Directory() {
			if modelId != nil && candidate.Id == *modelId {
				found := candidate
				entry = &found
				break
			}
		}
		if entry == nil && options.RecoverySnapshot == nil {
			Raise("model_unavailable", "No configured model for this instance")
		}
		if options.RecoverySnapshot != nil {
			configuration := options.RecoverySnapshot.Record.Configuration
			frozenModel := asMap(configuration.ExecutionConfiguration)["model"]
			body, _ := json.Marshal(frozenModel)
			var original ModelEntry
			if err := json.Unmarshal(body, &original); err != nil {
				panic(err)
			}
			restoreDurableModelHeaders(configuration, &original, options.Directory())
			entry = &original
		}
		modelNow := func(candidate ModelEntry) ModelEntry {
			if options.RecoverySnapshot != nil {
				return candidate
			}
			for _, live := range options.Directory() {
				if live.Id == candidate.Id {
					return live
				}
			}
			return candidate
		}
		endpointChanged := func(candidate ModelEntry, latest ModelEntry) bool {
			return latest.BaseUrl != candidate.BaseUrl || latest.Api != candidate.Api ||
				canonicalJSONString(latest.Headers) != canonicalJSONString(candidate.Headers)
		}
		resolveBindingFor := func(candidate ModelEntry) *PiAdapterBinding {
			if options.BindingFor != nil {
				if binding := options.BindingFor(candidate); binding != nil {
					return binding
				}
			}
			key := ""
			if options.ApiKeyFor != nil {
				if resolved := options.ApiKeyFor(candidate); resolved != nil {
					key = *resolved
				}
			}
			if key == "" && options.ApiKey != nil {
				key = *options.ApiKey
			}
			if key == "" {
				return nil
			}
			credentialId := candidate.CredentialId
			if credentialId == "" {
				credentialId = candidate.Id
			}
			return &PiAdapterBinding{ApiKey: key, CredentialId: credentialId}
		}
		resolveKeyFor := func(candidate ModelEntry) string {
			latest := modelNow(candidate)
			if endpointChanged(candidate, latest) {
				Raise("model_changed", "Model "+candidate.Id+" endpoint or protocol changed while this request waited; it will be re-prepared")
			}
			current := resolveBindingFor(candidate)
			if current == nil {
				Raise("model_unavailable", "No credential bound for model "+candidate.Id)
			}
			return current.ApiKey
		}
		if resolveBindingFor(*entry) == nil {
			Raise("model_unavailable", "No credential bound for model "+entry.Id)
		}
		scheduler := options.Scheduler
		setWaitingSlot := func(waiting bool) {
			now := NowMillis()
			if waiting {
				MarkOperationCredentialWait(options.Store, operation.Id, now)
				return
			}
			FinishOperationCredentialWait(options.Store, operation.Id, now)
		}
		slotFor := func(candidate ModelEntry) *piAdapterSlot {
			binding := resolveBindingFor(candidate)
			if binding == nil {
				Raise("model_unavailable", "No credential bound for model "+candidate.Id)
			}
			if scheduler == nil || (binding.Limit == nil && binding.GroupLimit == nil) {
				return nil
			}
			return &piAdapterSlot{acquire: func(signal *AbortSignal) (func(), error) {
				setWaitingSlot(true)
				var releaseCredential func()
				released := false
				release := func() {
					if released {
						return
					}
					released = true
					if releaseCredential != nil {
						releaseCredential()
					}
				}
				for {
					if endpointChanged(candidate, modelNow(candidate)) {
						release()
						setWaitingSlot(false)
						Raise("model_changed", "Model "+candidate.Id+" endpoint or protocol changed while this request waited; it will be re-prepared")
					}
					current := resolveBindingFor(candidate)
					if current == nil {
						release()
						setWaitingSlot(false)
						Raise("model_unavailable", "No credential bound for model "+candidate.Id)
					}
					request := SlotRequest{
						CredentialId:  current.CredentialId,
						ApiKey:        current.ApiKey,
						Limit:         current.Limit,
						SharedGroupId: stringValue(current.SharedGroupId),
						GroupLimit:    current.GroupLimit,
					}
					request.Refresh = func() SlotRequest {
						live := resolveBindingFor(candidate)
						if live == nil {
							return request
						}
						return SlotRequest{
							CredentialId:  live.CredentialId,
							ApiKey:        live.ApiKey,
							Limit:         live.Limit,
							SharedGroupId: stringValue(live.SharedGroupId),
							GroupLimit:    live.GroupLimit,
						}
					}
					granted, err := scheduler.Acquire(request, signal)
					if err != nil {
						release()
						setWaitingSlot(false)
						return nil, err
					}
					releaseCredential = granted
					after := resolveBindingFor(candidate)
					if after != nil && after.CredentialId == current.CredentialId && after.ApiKey == current.ApiKey {
						break
					}
					release()
				}
				WaitForAgentExecutionSlot(options.Store, operation.Id, signal)
				return release, nil
			}}
		}
		task := options.Store.Task(operation.TaskId)
		project, ok := graphDBRow(options.Store.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
		if !ok {
			Raise("not_found", "No project for this task")
		}
		projectRoot := graphDBString(project, "root")
		definitionVersionValue := "unknown@1"
		if definitionVersion != nil && *definitionVersion != "" {
			definitionVersionValue = *definitionVersion
		}
		fullAccess := true
		return func() OperationResult {
			interruptSignal := signalFor(operation.Id)
			defer dropSignal(operation.Id)
			return piAdapterRunOperation(options, transport, piAdapterRunInput{
				InterruptSignal:   interruptSignal,
				Operation:         operation,
				Entry:             *entry,
				ModelNow:          modelNow,
				EndpointChanged:   endpointChanged,
				ResolveKeyFor:     resolveKeyFor,
				ResolveBinding:    resolveBindingFor,
				SlotFor:           slotFor,
				Task:              task,
				ProjectRoot:       projectRoot,
				DefinitionVersion: definitionVersionValue,
				FullAccess:        fullAccess,
				ActiveInstances:   &activeInstances,
				ActiveMu:          &activeInstancesMu,
				TurnOrdinals:      &turnOrdinals,
				TurnOrdinalsMu:    &turnOrdinalsMu,
				SystemChanges:     &systemChangeApplications,
				SystemChangesMu:   &systemChangeApplicationsMu,
			})
		}
	}
	return adapter
}

func piAdapterCallableModels(directory []ModelEntry, resolve func(candidate ModelEntry) *PiAdapterBinding) []ModelEntry {
	if resolve == nil {
		return directory
	}
	callable := []ModelEntry{}
	for _, candidate := range directory {
		if piAdapterCallableModel(resolve, candidate) {
			callable = append(callable, candidate)
		}
	}
	return callable
}

func piAdapterCallableModel(resolve func(candidate ModelEntry) *PiAdapterBinding, candidate ModelEntry) (callable bool) {
	defer func() {
		if recover() != nil {
			callable = false
		}
	}()
	return resolve(candidate) != nil
}
