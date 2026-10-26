package graph

import (
	"encoding/json"
	"strings"
	"sync"
)

// One Pi operation is a whole session of provider calls, not a single request.
// This bound covers a long planning or coding session while still stopping a
// runaway loop for user acknowledgement inside the 20M instance budget.
const PI_SESSION_RESERVE = 2_000_000

// CONVERSATION_DELTA_FLUSH_MS coalesces live conversation text.
const CONVERSATION_DELTA_FLUSH_MS = 60

// PROMPT_SUGGESTION_TIMEOUT_MS bounds the composer suggestion call.
const PROMPT_SUGGESTION_TIMEOUT_MS = 5_000

// piModelView is the SDK model Graph sends with. It is exported through ToPiModel so the
// thinking-strength view is computed from the very object the transport uses.
type PiAdapterOptions struct {
	RecoverySnapshot *FrozenExecutionRecovery
	Store            *TaskStore
	InstancesDir     string
	Catalog          *Catalog
	Artifacts        *ArtifactWorkspace
	// Directory is the live model directory.
	Directory func() []ModelEntry
	// ApiKey is the fallback key for entries without a per-model credential binding.
	ApiKey *string
	// ApiKeyFor resolves the key per model so aliases on different credentials never share one.
	ApiKeyFor func(entry ModelEntry) *string
	// BindingFor is the full credential binding for one model.
	BindingFor func(entry ModelEntry) *PiAdapterBinding
	// Scheduler is the shared model scheduler.
	Scheduler *ModelScheduler
	// Sediment is the settings for the post-operation skill review, read live so the switch needs
	// no restart.
	Sediment func() SedimentSettings
	// ModelRuntime is the provider registry.
	ModelRuntime *ModelRuntime
	// Network is the reach the operation was granted.
	Network *PiAdapterNetwork
	// TaskSetups remembers which task setup a session already read.
	TaskSetups *TaskSetupLedger
	// CapabilitySecrets are the secrets a capability may read.
	CapabilitySecrets func() map[string]string
	// Channels are the host channels.
	Channels *PiAdapterChannels
	// Transport opens the Agent session.
	Transport AgentSessionTransport
	// DaemonNativeTools makes the daemon provide the native tools the
	// TypeScript SDK used to publish. It is set when the kernel runs without
	// an SDK of its own, so nothing else would offer read, write, edit, ls,
	// find, grep and the shell to the model.
	DaemonNativeTools bool
}

// CreatePiAdapter is the production Agent adapter: one Task Runtime operation opens a restored Pi
// instance and sends one prompt.
func CreatePiAdapter(options PiAdapterOptions) ActionAdapter {
	reserve := PI_SESSION_RESERVE
	transport := options.Transport
	if transport == nil {
		transport = CreatePigAgentSessionTransport(options.Store, CodemodeSettings{})
	}
	activeInstances := map[string]AgentSession{}
	activeInstancesMu := sync.Mutex{}
	// The live turn's ordinal allocator, so a steering message can take its place
	// in the order of the turn it interrupts.
	turnOrdinals := map[string]func() int{}
	turnOrdinalsMu := sync.Mutex{}
	systemChangeApplications := map[string]*piAdapterPending{}
	systemChangeApplicationsMu := sync.Mutex{}

	adapter := ActionAdapter{
		Kind:          "agent",
		ReserveTokens: &reserve,
	}
	adapter.CanReplayBeforeSend = func(operation Operation) bool {
		// Capability load is recorded before transport.open can start the Pi
		// session (including extension hooks). A model send is also recorded
		// before it reaches the provider. Only replay before both boundaries.
		capability, _ := graphDBRow(options.Store.Db, "SELECT 1 FROM node_capabilities WHERE operation_id=? LIMIT 1", operation.Id)
		invocation, _ := graphDBRow(options.Store.Db, "SELECT 1 FROM invocations WHERE operation_id=? LIMIT 1", operation.Id)
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
		// The injected message takes the next ordinal of the turn it interrupted, so
		// the transcript can show it where it landed instead of above the turn.
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
		if err := active.Interrupt(text); err != nil {
			if strings.Contains(err.Error(), "no longer accepting") || strings.Contains(err.Error(), "session is closed") {
				Raise("no_active_operation", "The master Agent is no longer accepting interruption")
			}
			panic(err)
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
	// Soft-stop the turn an operation is running: the in-flight tool call
	// finishes, the turn ends before the next model request, and the session is
	// retained. Idempotent when the operation has no live session.
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
		// waiting_slot is what keeps a parked operation out of execution
		// accounting; a failed write must fail the operation, not be hidden.
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
				// Waiting on a credential releases the execution slot; after the
				// credential slot is granted the operation must take an execution
				// slot back before it may send, or many waiters resuming at once
				// would exceed the global Agent limit.
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
					// The queued binding can change under a hot config apply. The
					// waiter asks for the live key/limits on every grant decision;
					// when the identity changed after the grant, the old slot is
					// returned and the request re-queues under the new identity
					// instead of sending with a stale or wrong-platform key.
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
		accessPolicy := operation.AccessPolicy
		if options.RecoverySnapshot != nil {
			configuration := options.RecoverySnapshot.Record.Configuration
			body, _ := json.Marshal(asMap(configuration.ExecutionConfiguration)["accessPolicy"])
			if string(body) != "null" {
				var original ResolvedAccessPolicy
				if err := json.Unmarshal(body, &original); err != nil {
					panic(err)
				}
				accessPolicy = &original
			}
		}
		fullAccess := IsFullAccess(accessPolicy)
		return func() OperationResult {
			return piAdapterRunOperation(options, transport, piAdapterRunInput{
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
				AccessPolicy:      accessPolicy,
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

// piAdapterCallableModels keeps the models a turn could actually call.
//
// A model whose credential cannot be resolved is not a candidate for an
// auxiliary call: choosing it would turn a missing key into a failure of the
// work that is already running.
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

// piAdapterCallableModel reports whether one model could be called right now.
func piAdapterCallableModel(resolve func(candidate ModelEntry) *PiAdapterBinding, candidate ModelEntry) (callable bool) {
	defer func() {
		if recover() != nil {
			callable = false
		}
	}()
	return resolve(candidate) != nil
}
