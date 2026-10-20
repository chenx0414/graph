package graph

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// The production Agent adapter: one Task Runtime operation opens a restored Pi instance and sends
// one prompt.
//
// The Pi SDK is not linked (RULEBOOK §7). The model the transport uses is built here
// (ToPiModel), the provider endpoints live in the ModelRuntime registry, and the session itself is
// opened through the AgentSessionTransport the host owns.

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
type piModelView struct {
	Id               string             `json:"id"`
	Name             string             `json:"name"`
	Provider         string             `json:"provider"`
	Api              ModelApi           `json:"api"`
	BaseUrl          string             `json:"baseUrl"`
	Reasoning        bool               `json:"reasoning"`
	Input            []ModelInput       `json:"input"`
	ContextWindow    int                `json:"contextWindow"`
	MaxTokens        int                `json:"maxTokens"`
	ThinkingLevelMap map[string]*string `json:"thinkingLevelMap,omitempty"`
	Cost             ModelCost          `json:"cost"`
	Headers          map[string]string  `json:"headers,omitempty"`
}

// ToPiModel builds the model the transport sends with.
func ToPiModel(entry ModelEntry) piModelView {
	headers := ModelRequestHeaders(entry)
	thinkingLevelMap := ThinkingLevelMapFor(entry)
	model := piModelView{
		Id:       entry.Id,
		Name:     entry.Id,
		Provider: entry.Provider,
		Api:      entry.Api,
		BaseUrl:  entry.BaseUrl,
		// Every model is treated as thinking-capable: the console no longer asks,
		// and the SDK's own supported-level rule short-circuits to `off` when this
		// flag is false. A legacy `reasoning: false` entry is therefore ignored.
		Reasoning:     true,
		Input:         []ModelInput{"text"},
		ContextWindow: entry.ContextWindow,
		MaxTokens:     entry.MaxTokens,
		// Pi's Model.cost is required numeric metadata; Graph billing uses catalog cost, never this placeholder.
		Cost: ModelCost{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0},
	}
	if entry.ModelId != "" {
		model.Id = entry.ModelId
	}
	if len(entry.Input) > 0 {
		model.Input = append([]ModelInput{}, entry.Input...)
	}
	if thinkingLevelMap != nil {
		// A model takes only the effort levels its catalog entry names; the SDK maps
		// Pi's level onto the provider's own value at the wire.
		model.ThinkingLevelMap = map[string]*string(thinkingLevelMap)
	}
	if entry.Cost != nil {
		model.Cost = *entry.Cost
	}
	if headers != nil {
		// Gateway routing headers (for example x-opencode-session) must travel
		// with every provider request.
		model.Headers = headers
	}
	return model
}

// ModelRuntime is the provider registry the daemon keeps for the models it may dispatch.
//
// The Pi SDK's ModelRuntime held the same registrations and dispatched them through the SDK's
// provider clients. The SDK is not linked here, so the registry is Graph's own and a provider call
// is one HTTP request through the shared HTTPClient (RULEBOOK §7): the same request shape, the
// same auth and the same streaming flag, and the e2e OpenRouter rewrite applies exactly as it
// does to every other provider request.
type ModelRuntime struct {
	mu        sync.RWMutex
	providers map[string]ProviderRegistration
}

// NewModelRuntime opens an empty provider registry.
func NewModelRuntime() *ModelRuntime {
	return &ModelRuntime{providers: map[string]ProviderRegistration{}}
}

// RegisterProvider registers or replaces one provider endpoint.
//
// Re-registering the same provider name replaces its endpoint/key, so a saved rotation applies to
// the next session opened for this provider.
func (m *ModelRuntime) RegisterProvider(name string, reg ProviderRegistration) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.providers == nil {
		m.providers = map[string]ProviderRegistration{}
	}
	m.providers[name] = reg
}

// Provider is one registered provider endpoint.
func (m *ModelRuntime) Provider(name string) (ProviderRegistration, bool) {
	if m == nil {
		return ProviderRegistration{}, false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	reg, ok := m.providers[name]
	return reg, ok
}

// Providers is the registered provider names, sorted.
func (m *ModelRuntime) Providers() []string {
	if m == nil {
		return []string{}
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	names := make([]string, 0, len(m.providers))
	for name := range m.providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ProviderRequest is one provider call.
type ProviderRequest struct {
	Model    string
	Messages []any
	System   *string
	Stream   bool
	Options  map[string]any
}

// ProviderResponse is the provider's answer.
type ProviderResponse struct {
	Status int
	Header http.Header
	Body   []byte
}

// Send performs one provider call against a registered endpoint.
//
// The request shape is the provider's own: an OpenAI-compatible endpoint takes
// `{model, messages, stream}` and an Anthropic endpoint takes
// `{model, max_tokens, messages, system, stream}`. The key travels as `Authorization: Bearer` for
// the former and `x-api-key` for the latter, and the registered headers travel with every call.
func (m *ModelRuntime) Send(provider string, request ProviderRequest) (*ProviderResponse, error) {
	reg, ok := m.Provider(provider)
	if !ok {
		return nil, errors.New("Unknown provider: " + provider)
	}
	if reg.BaseURL == "" {
		return nil, errors.New("Provider " + provider + " has no baseUrl")
	}
	body, err := providerRequestBody(reg.API, request)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, providerEndpoint(reg.BaseURL, reg.API), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range providerRequestHeaders(reg) {
		httpRequest.Header.Set(key, value)
	}
	httpRequest.Header.Set("content-type", "application/json")
	response, err := HTTPClient.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := ReadBody(response.Body)
	if err != nil {
		return nil, err
	}
	return &ProviderResponse{Status: response.StatusCode, Header: response.Header, Body: payload}, nil
}

// providerEndpoint is the path a provider API takes.
func providerEndpoint(baseURL string, api ModelApi) string {
	trimmed := strings.TrimRight(baseURL, "/")
	switch string(api) {
	case "anthropic-messages":
		return trimmed + "/messages"
	default:
		return trimmed + "/chat/completions"
	}
}

// providerRequestHeaders are the auth and routing headers of one provider call.
func providerRequestHeaders(reg ProviderRegistration) map[string]string {
	headers := map[string]string{}
	for key, value := range reg.Headers {
		headers[key] = value
	}
	explicit := func(name string) bool {
		for key := range headers {
			if strings.EqualFold(key, name) {
				return true
			}
		}
		return false
	}
	if reg.APIKey != "" {
		if string(reg.API) == "anthropic-messages" {
			if !explicit("x-api-key") {
				headers["x-api-key"] = reg.APIKey
			}
			if !explicit("anthropic-version") {
				headers["anthropic-version"] = "2023-06-01"
			}
		} else {
			if !explicit("authorization") {
				headers["authorization"] = "Bearer " + reg.APIKey
			}
		}
	}
	return headers
}

// providerRequestBody is the wire body of one provider call, in the provider's own field order.
func providerRequestBody(api ModelApi, request ProviderRequest) ([]byte, error) {
	if string(api) == "anthropic-messages" {
		payload := map[string]any{
			"model":    request.Model,
			"messages": request.Messages,
		}
		if limit, ok := request.Options["maxTokens"]; ok {
			payload["max_tokens"] = limit
		}
		if request.System != nil {
			payload["system"] = *request.System
		}
		payload["stream"] = request.Stream
		return json.Marshal(payload)
	}
	payload := map[string]any{
		"model":    request.Model,
		"messages": request.Messages,
		"stream":   request.Stream,
	}
	for key, value := range request.Options {
		if key == "maxTokens" {
			payload["max_tokens"] = value
			continue
		}
		payload[key] = value
	}
	return json.Marshal(payload)
}

// ToolResultText is the words a tool result carries, as the model saw them.
//
// Pi hands a tool result back as `{ content: [{ type: 'text', text }] }`, and on a failure the reason
// is in that text and nowhere else. A record that keeps only `isError` is a boolean nobody can
// diagnose with, so the reason is kept beside it, bounded - a failing command can return megabytes.
func ToolResultText(result any, limit int) string {
	if limit <= 0 {
		limit = 2_000
	}
	record, _ := result.(map[string]any)
	content, _ := record["content"].([]any)
	parts := []string{}
	for _, item := range content {
		part, _ := item.(map[string]any)
		if part["type"] != "text" {
			continue
		}
		text, ok := part["text"].(string)
		if !ok {
			continue
		}
		parts = append(parts, text)
	}
	joined := strings.TrimSpace(strings.Join(parts, "\n"))
	runes := []rune(joined)
	if len(runes) > limit {
		return string(runes[:limit]) + "…（已截断）"
	}
	return joined
}

// summarizeToolCall is the one-line summary of a tool call for the conversation activity stream.
func summarizeToolCall(name string, args any) string {
	body, _ := args.(map[string]any)
	if body == nil {
		body = map[string]any{}
	}
	target := func(key string) string {
		value, _ := body[key].(string)
		return value
	}
	first := func(values ...string) string {
		for _, value := range values {
			if value != "" {
				return value
			}
		}
		return ""
	}
	join := func(values ...string) string {
		kept := []string{}
		for _, value := range values {
			if value != "" {
				kept = append(kept, value)
			}
		}
		return strings.Join(kept, " ")
	}
	summary := name
	switch {
	case name == "bash":
		summary = first(target("command"), name)
	case name == "grep" || name == "rg":
		summary = first(join(target("pattern"), target("path")), name)
	case name == "ls" || name == "glob":
		summary = first(target("path"), target("pattern"), name)
	case name == "read" || name == "write_file" || name == "list_dir":
		summary = first(target("path"), name)
	case name == "artifact_publish":
		summary = first(join(target("namespace"), target("name")), name)
	case name == "artifact_read" || name == "artifact_retire":
		version := ""
		if number, ok := body["version"].(float64); ok {
			version = fmt.Sprintf("@%v", number)
		}
		summary = first(target("artifactId"), name) + version
	case name == "artifact_list":
		summary = first(target("namespace"), target("prefix"), name)
	case name == "run_command":
		values := []string{target("command")}
		if list, ok := body["args"].([]any); ok {
			for _, item := range list {
				values = append(values, fmt.Sprintf("%v", item))
			}
		}
		summary = join(values...)
	case name == "fetch":
		summary = first(target("url"), name)
	case name == "propose_graph" || name == "confirm_draft":
		summary = "draft"
	case name == "validate_proposal":
		summary = "validation"
	case name == "get_graph_state":
		summary = "current graph"
	case name == "get_task_status":
		summary = "task status"
	case name == "bind_project":
		summary = first(target("projectId"), name)
	case strings.HasPrefix(name, "git_"):
		summary = join(name, first(target("path"), target("ref")))
	case name == "apply_rsi_change":
		summary = first(target("title"), "self-improvement")
	case name == "inspect_rsi_status":
		summary = "self-improvement status"
	}
	runes := []rune(summary)
	if len(runes) > 160 {
		return string(runes[:157]) + "..."
	}
	return summary
}

// combineKnownUsage adds two usage reports when both are known.
func combineKnownUsage(base *TokenUsage, extra *TokenUsage) *TokenUsage {
	if base == nil || extra == nil {
		return base
	}
	source := MergeUsageSource(UsageSourceOf(base), UsageSourceOf(extra))
	return &TokenUsage{
		Input:       base.Input + extra.Input,
		Output:      base.Output + extra.Output,
		CacheRead:   base.CacheRead + extra.CacheRead,
		CacheWrite:  base.CacheWrite + extra.CacheWrite,
		UsageSource: &[]string{string(source)}[0],
	}
}

// PiAdapterChannels are the host channels an Agent session may reach.
type PiAdapterChannels struct {
	// Conversations is the conversation service, as far as tools over other conversations need it.
	Conversations *ConversationToolService
	// Supervisor is the Graph management surface of one task.
	Supervisor func(taskId string) PiAdapterSupervisor
	// Catalog is the capability catalog the session reads.
	Catalog *Catalog
	// Peers is same-graph Agent-to-Agent delivery: a peer's message reaches the target node like a
	// user prompt.
	Peers func(taskId string) PiAdapterPeers
	// AgentContext is the prompt library.
	AgentContext *AgentContextLibrary
	// BootstrapPrompts are the per-definition Graph prompts.
	BootstrapPrompts map[string]string
	// BootstrapToolPrompt is the Graph tool prompt.
	BootstrapToolPrompt *string
	// SystemContext is the system summary channel.
	SystemContext *PiAdapterSystemContext
	// Rsi is the self-improvement channel.
	Rsi *PiAdapterRsi
}

// PiAdapterSupervisor is the Graph management surface one Agent session may drive.
type PiAdapterSupervisor struct {
	Propose          func(proposal NativeProposal, requestId string, newVersion bool) any
	WithdrawDraft    func(input PiAdapterDraftAction) any
	ConfirmDraft     func(input PiAdapterConfirmDraft) any
	ArchiveDraft     func(input PiAdapterDraftAction) any
	RestoreDraft     func(input PiAdapterDraftAction) any
	DeleteDraft      func(input PiAdapterDraftAction) any
	GraphState       func() any
	TaskStatus       func(input PiAdapterTaskStatus) any
	ValidateProposal func(proposal NativeProposal) any
	ListProjects     func() any
	BindProject      func(input PiAdapterBindProject) any
	ListProblems     func() any
	ResolveProblem   func(input PiAdapterResolveProblem) any
	// GraphManagement is the graph control surface the main Agent owns. The
	// TypeScript supervisor spread graphManagement() into itself, so the
	// graph tools read the same surface the supervisor exposes.
	GraphManagement AgentToolsGraphManagement
}

// PiAdapterDraftAction is one draft-scoped supervisor call.
type PiAdapterDraftAction struct {
	ProposalVersion int
	Reason          *string
	RequestId       string
}

// PiAdapterConfirmDraft approves one draft revision.
type PiAdapterConfirmDraft struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	Instruction     string
	RequestId       string
}

// PiAdapterTaskStatus asks the supervisor about a task or node.
type PiAdapterTaskStatus struct {
	TaskId      *string
	NodeId      *string
	WaitForNode *string
	TimeoutMs   *int
}

// PiAdapterBindProject binds a project to the running task.
type PiAdapterBindProject struct {
	ProjectId string
	RequestId string
}

// PiAdapterResolveProblem answers one parked problem.
type PiAdapterResolveProblem struct {
	QuestionId string
	Action     string
	Response   *string
	Proof      *string
	RequestId  string
}

// PiAdapterPeers is the peer delivery surface of one task.
type PiAdapterPeers struct {
	Deliver func(from string, input PiAdapterPeerDelivery) any
}

// PiAdapterPeerDelivery is one peer message.
type PiAdapterPeerDelivery struct {
	To        string
	Text      string
	RequestId string
}

// PiAdapterSystemContext is the system summary channel.
type PiAdapterSystemContext struct {
	SystemSummary func() map[string]any
}

// PiAdapterRsi is the self-improvement channel.
type PiAdapterRsi struct {
	Available bool
	// Status adds the checkout comparison (sync.deploy), which walks both checkouts through git.
	Status func(compare bool) any
	Apply  func(input any, context PiAdapterRsiContext) map[string]any
}

// PiAdapterRsiContext is the operation a self-improvement change belongs to.
type PiAdapterRsiContext struct {
	TaskId         string
	ConversationId *string
	OperationId    *string
}

// PiAdapterBinding is the full credential binding for one model, including concurrency caps.
type PiAdapterBinding struct {
	ApiKey        string
	CredentialId  string
	Limit         *int
	SharedGroupId *string
	GroupLimit    *int
}

// PiAdapterNetwork is the network reach one operation was granted.
type PiAdapterNetwork struct {
	RetrievalDomains []string
	McpDomains       []string
}

// PiAdapterOptions are the inputs of the production Agent adapter.
type PiAdapterOptions struct {
	RecoverySnapshot map[string]any
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
		transport = CreateDurableAgentSessionTransport(options.Store)
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
			configuration := asMap(asMap(options.RecoverySnapshot["snapshot"])["configuration"])
			frozenModel := asMap(configuration["executionConfiguration"])["model"]
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
			configuration := asMap(asMap(options.RecoverySnapshot["snapshot"])["configuration"])
			body, _ := json.Marshal(asMap(configuration["executionConfiguration"])["accessPolicy"])
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

// piAdapterSlot is one credential slot acquirer.
type piAdapterSlot struct {
	acquire func(signal *AbortSignal) (func(), error)
}

// piAdapterPending is one in-flight system-change application.
type piAdapterPending struct {
	done  chan struct{}
	value any
	err   error
}

// piAdapterRunInput is the prepared state of one operation.
type piAdapterRunInput struct {
	Operation         Operation
	Entry             ModelEntry
	ModelNow          func(candidate ModelEntry) ModelEntry
	EndpointChanged   func(candidate ModelEntry, latest ModelEntry) bool
	ResolveKeyFor     func(candidate ModelEntry) string
	ResolveBinding    func(candidate ModelEntry) *PiAdapterBinding
	SlotFor           func(candidate ModelEntry) *piAdapterSlot
	Task              TaskRow
	ProjectRoot       string
	DefinitionVersion string
	AccessPolicy      *ResolvedAccessPolicy
	FullAccess        bool
	ActiveInstances   *map[string]AgentSession
	ActiveMu          *sync.Mutex
	TurnOrdinals      *map[string]func() int
	TurnOrdinalsMu    *sync.Mutex
	SystemChanges     *map[string]*piAdapterPending
	SystemChangesMu   *sync.Mutex
}

// stringValue reads an optional string.
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// canonicalJSONString is the TypeScript JSON.stringify of a value, for comparison.
func canonicalJSONString(value any) string {
	if value == nil {
		return "{}"
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// piAdapterRealpath is realpath() with the TypeScript fallback to the original path.
func piAdapterRealpath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

// piAdapterOptionalRealpath is realpath() with the TypeScript `.catch(() => undefined)`
// fallback. A root that cannot be resolved is dropped from the grant list instead
// of being handed to the sandbox as a path that does not exist.
func piAdapterOptionalRealpath(path string) string {
	if path == "" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	return resolved
}

// piAdapterRunOperation is the body of one prepared Agent operation: it opens the session, sends
// the prompt, and settles the operation.
func piAdapterRunOperation(options PiAdapterOptions, transport AgentSessionTransport, input piAdapterRunInput) OperationResult {
	operation := input.Operation
	entry := input.Entry
	store := options.Store
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	nodeId := operation.NodeId
	gate := TaskGate(store, TaskGateOperation{
		Id: operation.Id, TaskId: operation.TaskId, InstanceId: instanceId, NodeId: &nodeId,
	}, entry, TaskGateOptions{Unrestricted: input.FullAccess})
	// A pre-send gate refusal (pause, budget, unknown usage) surfaces as an
	// error inside the Pi session; keep it so the operation is not recorded
	// as a success with zero provider requests.
	var gateRefusal error
	observedGate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			sending := false
			defer func() {
				if rec := recover(); rec != nil {
					if !sending {
						gateRefusal = asError(rec)
					}
					panic(rec)
				}
			}()
			return gate.Dispatch(id, reservation, func() any {
				sending = true
				return send()
			})
		},
		Settle: func(id string, usage *TokenUsage) { gate.Settle(id, usage) },
	}
	specRow, ok := graphDBRow(store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", operation.TaskId, operation.NodeId)
	if !ok {
		Raise("not_found", "No node for this operation")
	}
	var spec NodeSpec
	if err := json.Unmarshal([]byte(graphDBString(specRow, "spec")), &spec); err != nil {
		panic(err)
	}
	if options.RecoverySnapshot != nil {
		configuration := asMap(asMap(options.RecoverySnapshot["snapshot"])["configuration"])
		body, _ := json.Marshal(asMap(configuration["executionConfiguration"])["spec"])
		if err := json.Unmarshal(body, &spec); err != nil {
			panic(err)
		}
	}
	var conversation *ConversationRow
	if input.Task.Phase == "chatting" {
		conversation = ConversationForTask(store, operation.TaskId)
	}
	workspace := piAdapterRealpath(input.ProjectRoot)
	if operation.Workspace != nil && *operation.Workspace != "" {
		workspace = piAdapterRealpath(*operation.Workspace)
	}
	var permissionRequest *CapabilityPermissionRequest
	var askedQuestion *PiAdapterAskedQuestion
	var reloadReceipt map[string]any
	channels := options.Channels
	var agentPromptLibrary *AgentContextLibrary
	if channels != nil {
		agentPromptLibrary = channels.AgentContext
	}
	role := ""
	if spec.Role != nil {
		role = *spec.Role
	}
	systemDomains := []string{}
	if role == "master" {
		systemDomains = []string{"github.com", "raw.githubusercontent.com", "api.github.com"}
	}
	retrievalDomains := []string{}
	if options.Network != nil {
		retrievalDomains = append(retrievalDomains, options.Network.RetrievalDomains...)
	}
	retrievalDomains = append(retrievalDomains, systemDomains...)
	retrievalDomains = piAdapterUnique(retrievalDomains)
	unrestrictedRetrieval := input.AccessPolicy != nil && input.AccessPolicy.Network == "unrestricted"
	var retrieval *RetrievalBroker
	if len(retrievalDomains) > 0 || unrestrictedRetrieval {
		retrieval = CreateRetrievalBroker(retrievalDomains, observedGate, unrestrictedRetrieval, 0, 0)
	}
	artifactService := piAdapterArtifactService(options, input, spec, workspace, role)

	var capabilityOperation CapabilityOperation
	var commands *WorkspaceCommandRunner
	var contextAssembly *AgentContextAssembly
	var setupError error
	setupFailed := func(err error) OperationResult {
		if commands != nil {
			commands.Close()
		}
		return OperationResult{
			Outcome: "failed",
			Output:  map[string]any{"setupError": err.Error()},
			Usage:   &TokenUsage{},
		}
	}
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				capabilityOperation = CapabilityOperation{}
				commands = nil
				setupError = asError(rec)
			}
		}()
		definitionId := ""
		if strings.Contains(input.DefinitionVersion, "@") {
			definitionId = strings.Split(input.DefinitionVersion, "@")[0]
		}
		skillCapabilityRoot := ""
		if options.Catalog != nil {
			skillCapabilityRoot = options.Catalog.CapabilityRootPath()
		}
		assemblyInput := AgentContextAssemblyOptions{
			CapabilityBundleOptions: CapabilityBundleOptions{
				Catalog: options.Catalog, DefinitionVersion: input.DefinitionVersion,
				SkillProjectRoot: input.ProjectRoot,
			},
			Action: spec.Action, Role: role, Runtime: "worker", Workspace: workspace,
			FullAccess: input.FullAccess, Retrieval: retrieval != nil,
			Rsi: channels != nil && channels.Rsi != nil && channels.Rsi.Available && role == "master" && input.FullAccess,
		}
		if agentPromptLibrary != nil {
			assemblyInput.Library = agentPromptLibrary
		}
		if channels != nil {
			if definitionId != "" && channels.BootstrapPrompts != nil {
				if prompt, ok := channels.BootstrapPrompts[definitionId]; ok && prompt != "" {
					assemblyInput.Bootstrap = &CapabilityBootstrap{Agent: prompt}
				}
			}
			if channels.BootstrapToolPrompt != nil {
				if assemblyInput.Bootstrap == nil {
					assemblyInput.Bootstrap = &CapabilityBootstrap{}
				}
				assemblyInput.Bootstrap.Tool = *channels.BootstrapToolPrompt
			}
		}
		if options.Network != nil && len(options.Network.McpDomains) > 0 {
			assemblyInput.McpDomains = options.Network.McpDomains
		}
		if options.CapabilitySecrets != nil {
			assemblyInput.Secrets = options.CapabilitySecrets
		}
		if definitionId != "" && skillCapabilityRoot != "" {
			assemblyInput.SkillFolder = AgentSkillsDir(definitionId, filepath.Dir(skillCapabilityRoot))
			assemblyInput.SkillOwnedRoots = AgentSkillOwnedRoots(skillCapabilityRoot, filepath.Dir(options.InstancesDir))
		}
		if options.RecoverySnapshot != nil {
			descriptor := asMap(options.RecoverySnapshot["restoredDescriptor"])
			body, _ := json.Marshal(descriptor["facts"])
			facts := []ResolvedCapabilityFact{}
			if err := json.Unmarshal(body, &facts); err != nil {
				panic(err)
			}
			assemblyInput.FrozenFacts = facts
			assemblyInput.SkillFolder = ""
		}
		contextAssembly = OpenAgentContextAssembly(assemblyInput)
		capabilityRoot := ""
		if role == "master" && options.Catalog != nil && options.Catalog.CapabilityRootPath() != "" {
			capabilityRoot = piAdapterOptionalRealpath(options.Catalog.CapabilityRootPath())
		}
		graphRoot := ""
		if role == "master" {
			graphRoot = piAdapterOptionalRealpath(GraphApplicationRoot())
		}
		masterReadRoots := []string{}
		if role == "master" {
			for _, path := range []string{capabilityRoot, graphRoot, agentContextRoot(agentPromptLibrary)} {
				if path != "" {
					masterReadRoots = append(masterReadRoots, path)
				}
			}
			masterReadRoots = piAdapterUnique(masterReadRoots)
		}
		// The work copy is dependency-free on disk; the project's own install
		// is linked in and granted to the sandbox so a worker command resolves
		// the project toolchain the way it would in the project root.
		dependencies := LinkProjectDependencies(workspace, nil)
		commandReadPaths := []string(nil)
		if dependencies != nil {
			commandReadPaths = []string{*dependencies}
		}
		commands = OpenWorkspaceCommandRunner(
			workspace,
			filepath.Join(options.InstancesDir, instanceId, "command-scratch"),
			observedGate,
			commandReadPaths,
			nil,
			false,
			input.AccessPolicy,
			false,
			0,
		)
		operationInput := CapabilityOperationOptions{
			Workspace:           workspace,
			ScratchDir:          filepath.Join(options.InstancesDir, instanceId, "capability-scratch"),
			Gate:                observedGate,
			Action:              spec.Action,
			Role:                role,
			NativeTools:         PiNativeToolNamesForPlatform(),
			Access:              input.AccessPolicy,
			Grants:              operation.Grants,
			DisabledTools:       contextAssembly.DisabledTools,
			AdditionalReadRoots: masterReadRoots,
			OnPermissionRequired: func(request CapabilityPermissionRequest) {
				if permissionRequest == nil {
					copied := request
					permissionRequest = &copied
				}
			},
		}
		// The native tools of the PiG kernel are the daemon's own: the kernel owns
		// no environment, so the tools the SDK used to provide are built here.
		var nativeToolInput *AgentToolsInput
		operationInput.HostTools = func(readRoots []string) []ToolDefinition {
			tools := AgentToolsInput{
				Workspace: workspace, Role: role, ReadRoots: append([]string{}, readRoots...), Catalog: options.Catalog,
				Access: input.AccessPolicy,
				Run: func(command string, args []string, signal *AbortSignal) CommandResult {
					return commands.Run(command, args, signal)
				},
			}
			built := tools
			nativeToolInput = &built
			if role != "" {
				tools.Role = role
			}
			// The tool surface records the agent's own question here; the capability
			// layer above knows nothing about it.
			tools.OnAskUser = func(request PiAdapterAskedQuestion) {
				if askedQuestion == nil {
					copied := request
					askedQuestion = &copied
				}
			}
			if retrieval != nil {
				tools.Fetch = func(url string, signal *AbortSignal) RetrievalResult {
					return retrieval.Fetch(url, signal)
				}
			}
			if artifactService != nil {
				tools.Artifacts = artifactService
			}
			// A graph node may talk to the other Agents of its OWN graph. The reach rule is the
			// graph itself: a node of another graph is not a peer, so naming one is refused.
			if role != "master" && channels != nil && channels.Peers != nil {
				peers := channels.Peers(operation.TaskId)
				tools.Peers = PiAdapterPeerTools{
					List: func() []PiAdapterPeerNode {
						nodes := []PiAdapterPeerNode{}
						for _, node := range PeerNodes(store, operation.TaskId) {
							nodes = append(nodes, PiAdapterPeerNode{Id: node.Id, Role: node.Role, Status: node.Status})
						}
						return nodes
					},
					Send: func(request PiAdapterPeerRequest) any {
						if peers.Deliver == nil {
							panic(errors.New("This Agent session has no graph peers"))
						}
						return peers.Deliver(operation.NodeId, PiAdapterPeerDelivery{To: request.To, Text: request.Text, RequestId: request.RequestId})
					},
				}
			}
			// A master session may hand work to any other conversation. The rules and the handoff
			// ledger live in `conversation-tools.ts`.
			if channels != nil && channels.Conversations != nil && conversation != nil && role == "master" {
				tools.Conversations = OpenConversationTools(
					*channels.Conversations,
					ConversationToolCaller{ConversationID: conversation.Id, TaskID: operation.TaskId, NodeID: operation.NodeId},
					input.AccessPolicy != nil && IsFullAccess(input.AccessPolicy),
					func(record map[string]any) { store.Event(operation.TaskId, "conversation.handed_off", record) },
				)
			}
			if channels != nil {
				supervisor := channels.Supervisor(operation.TaskId)
				tools.Supervisor = supervisor
				// The TypeScript supervisor carries the graph control surface, so
				// the graph tools read it from the same place.
				tools.GraphManagement = supervisor.GraphManagement
				tools.Catalog = channels.Catalog
			}
			// The self-improvement tools change the Graph source checkout, so they
			// belong to the master alone and only to a session that may act on the
			// host. The status stays available without a checkout - it names the
			// reason there is none - while an apply needs one to change.
			if channels != nil && channels.Rsi != nil && role == "master" && input.FullAccess {
				tools.Rsi = &AgentToolsRsi{Status: channels.Rsi.Status}
				if channels.Rsi.Available {
					tools.Rsi.Apply = channels.Rsi.Apply
				}
				rsiContext := PiAdapterRsiContext{TaskId: operation.TaskId, OperationId: &operation.Id}
				if conversation != nil {
					conversationId := conversation.Id
					rsiContext.ConversationId = &conversationId
				}
				tools.RsiContext = rsiContext
			}
			return AgentTools(tools)
		}
		operationInput.NativeToolsProvider = func(granted []string) []ToolDefinition {
			if nativeToolInput == nil || !options.DaemonNativeTools {
				return nil
			}
			return PigNativeTools(*nativeToolInput, granted)
		}
		capabilityOperation = contextAssembly.Bundle.OpenOperation(operationInput)
	}()
	if setupError != nil {
		return setupFailed(setupError)
	}
	defer func() {
		if capabilityOperation.Close != nil {
			capabilityOperation.Close()
		}
		if commands != nil {
			commands.Close()
		}
	}()

	tools := append([]ToolDefinition{}, capabilityOperation.Tools...)
	// A stored level can predate a catalog refresh, or name a model the
	// snapshot does not list: clamp it to a level this model accepts before
	// the turn runs, using the same SDK rule the console displays.
	thinkingLevel := "off"
	if conversation != nil && conversation.ThinkingLevel != nil {
		thinkingLevel = *conversation.ThinkingLevel
	}
	model := ToPiModel(entry)
	thinkingLevel = clampThinkingLevel(model.Reasoning, model.ThinkingLevelMap, thinkingLevel)
	modelPolicyDigest := contextDigest(map[string]any{
		"id":            entry.Id,
		"modelId":       piAdapterNullableString(entry.ModelId),
		"provider":      entry.Provider,
		"api":           string(entry.Api),
		"baseUrl":       entry.BaseUrl,
		"contextWindow": entry.ContextWindow,
		"maxTokens":     entry.MaxTokens,
		"thinkingLevel": thinkingLevel,
	})
	toolPolicyDigest := capabilityOperation.ToolPolicyDigest
	composedPrompt := contextAssembly.ForOperation(capabilityOperation).Composed.Text
	agentContext := operation.Context.AgentContext
	// Record what was actually loaded for this operation so the node
	// projection cannot later guess from catalog status.
	RecordCapabilityLoad(store, NodeCapabilityLoadInput{
		TaskId: operation.TaskId, NodeId: operation.NodeId, InstanceId: instanceId,
		OperationId: operation.Id, ReadOnly: false, Report: capabilityOperation.Report,
		Digest: capabilityOperation.BundleDigest, ToolPolicyDigest: capabilityOperation.ToolPolicyDigest,
		RuntimePolicyDigest: capabilityOperation.RuntimePolicyDigest,
	})
	// Live conversation text and tool activity are separate from the final
	// message: deltas are coalesced for reconnect, the durable record is
	// written by the kernel when the operation settles.
	parts := map[string]*piAdapterPart{}
	partsOrder := []string{}
	var entrySeq int
	currentEntryId := ""
	var ordinal int
	nextOrdinal := func() int {
		ordinal++
		return ordinal
	}
	input.TurnOrdinalsMu.Lock()
	(*input.TurnOrdinals)[operation.Id] = nextOrdinal
	input.TurnOrdinalsMu.Unlock()
	flushPart := func(part *piAdapterPart, force bool) {
		if conversation == nil || part.buffer == "" {
			return
		}
		now := NowMillis()
		if !force && now-part.lastFlush < CONVERSATION_DELTA_FLUSH_MS {
			return
		}
		text := part.buffer
		part.buffer = ""
		part.lastFlush = now
		PublishConversationDelta(store, PiAdapterConversationDelta{
			TaskId: operation.TaskId, ConversationId: conversation.Id, OperationId: operation.Id,
			EntryId: part.entryId, PartId: part.partId, Ordinal: part.ordinal, Delta: text,
			Text: part.text, Length: len([]rune(part.text)),
		})
	}
	flushDeltas := func(force bool) {
		for _, key := range partsOrder {
			flushPart(parts[key], force)
		}
	}
	toolSummaries := map[string]string{}
	activeConversationTools := map[string]bool{}
	toolActivity := []PiAdapterToolActivity{}
	// Ordered turn activity for a conversation transcript: the narration
	// between tool calls and the tool calls themselves, in the order they
	// happened.
	activity := []PiAdapterActivityRecord{}
	narrationByEntry := map[string]*PiAdapterActivityRecord{}
	toolOrdinals := map[string]int{}
	livePart := func(contentIndex int) *piAdapterPart {
		if currentEntryId == "" {
			entrySeq++
			currentEntryId = fmt.Sprintf("entry-%d", entrySeq)
		}
		partId := fmt.Sprintf("%d", contentIndex)
		key := currentEntryId + "\x00" + partId
		if existing, ok := parts[key]; ok {
			return existing
		}
		part := &piAdapterPart{entryId: currentEntryId, partId: partId, ordinal: nextOrdinal()}
		parts[key] = part
		partsOrder = append(partsOrder, key)
		narration := &PiAdapterActivityRecord{Type: "narration", Ordinal: part.ordinal}
		activity = append(activity, *narration)
		narrationByEntry[currentEntryId] = narration
		return part
	}
	persistEntries := conversation == nil
	sawAssistantMessageEnd := false
	compacting := false
	onEvent := func(event map[string]any) {
		kind, _ := event["type"].(string)
		switch kind {
		case "message_start":
			entrySeq++
			currentEntryId = fmt.Sprintf("entry-%d", entrySeq)
			return
		case "message_update":
			update, _ := event["assistantMessageEvent"].(map[string]any)
			if update == nil || update["type"] != "text_delta" {
				return
			}
			contentIndex := int(asFloatValue(update["contentIndex"]))
			delta, _ := update["delta"].(string)
			part := livePart(contentIndex)
			part.text += delta
			part.buffer += delta
			flushPart(part, false)
			return
		case "message_end":
			// Real assistant message from the Pi session, not a fabricated
			// summary of the final output.
			message, _ := event["message"].(map[string]any)
			role, _ := message["role"].(string)
			text := piAdapterAssistantText(message)
			if role == "assistant" && strings.TrimSpace(text) != "" {
				if persistEntries {
					sawAssistantMessageEnd = true
					AppendNodeEntry(store, NodeEntryInput{
						TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
						ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "assistant", Kind: "message", Text: text,
					})
				} else {
					// The same narration a subagent window shows between its tool
					// calls, kept as one readable record of the turn.
					narration := narrationByEntry[currentEntryId]
					if narration != nil {
						narration.Text = text
					} else {
						record := PiAdapterActivityRecord{Type: "narration", Text: text, Ordinal: nextOrdinal()}
						narrationByEntry[currentEntryId] = &record
						activity = append(activity, record)
					}
				}
			}
			if !persistEntries {
				flushDeltas(true)
				currentEntryId = ""
			}
			return
		case "tool_execution_start":
			toolName, _ := event["toolName"].(string)
			toolCallId, _ := event["toolCallId"].(string)
			if persistEntries {
				AppendNodeEntry(store, NodeEntryInput{
					TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
					ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "tool", Kind: "call",
					Text: summarizeToolCall(toolName, event["args"]),
					Data: map[string]any{"toolCallId": toolCallId, "toolName": toolName},
				})
			}
			if conversation == nil {
				return
			}
			summary := summarizeToolCall(toolName, event["args"])
			toolSummaries[toolCallId] = summary
			callOrdinal := nextOrdinal()
			toolOrdinals[toolCallId] = callOrdinal
			activity = append(activity, PiAdapterActivityRecord{
				Type: "tool", ToolCallId: toolCallId, Name: toolName, Summary: summary, State: "done", Ordinal: callOrdinal,
			})
			flushDeltas(true)
			activeConversationTools[toolCallId] = true
			PersistConversationActivity(store, conversation.Id, operation.Id, operation.Attempt,
				ConversationActivityRecords(activity, ""), activeConversationTools)
			store.Event(operation.TaskId, "message.tool", map[string]any{
				"operationId": operation.Id, "phase": "start", "toolCallId": toolCallId, "toolName": toolName,
				"summary": summary, "ordinal": callOrdinal,
			})
		case "tool_execution_end":
			toolName, _ := event["toolName"].(string)
			toolCallId, _ := event["toolCallId"].(string)
			isError, _ := event["isError"].(bool)
			if persistEntries {
				// A failure's reason lives in the result text and nowhere else. Recording only `isError`
				// throws away the one account of what went wrong.
				reason := ""
				if isError {
					reason = ToolResultText(event["result"], 2_000)
				}
				text := "工具执行完成"
				if isError {
					text = "工具执行失败：" + truncateRunes(reason, 400)
				}
				data := map[string]any{"toolCallId": toolCallId, "toolName": toolName, "isError": isError}
				if reason != "" {
					data["message"] = reason
				}
				AppendNodeEntry(store, NodeEntryInput{
					TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
					ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "tool", Kind: "result",
					Text: text, Data: data,
				})
			}
			if conversation == nil {
				return
			}
			summary := toolSummaries[toolCallId]
			if summary == "" {
				summary = toolName
			}
			state := "done"
			if isError {
				state = "error"
			}
			toolActivity = append(toolActivity, PiAdapterToolActivity{
				ToolCallId: toolCallId, Name: toolName, Summary: summary, State: state,
			})
			for i := range activity {
				if activity[i].Type == "tool" && activity[i].ToolCallId == toolCallId {
					activity[i].State = state
				}
			}
			delete(activeConversationTools, toolCallId)
			PersistConversationActivity(store, conversation.Id, operation.Id, operation.Attempt,
				ConversationActivityRecords(activity, ""), activeConversationTools)
			store.Event(operation.TaskId, "message.tool", map[string]any{
				"operationId": operation.Id, "phase": "end", "toolCallId": toolCallId, "toolName": toolName,
				"summary": summary, "isError": isError, "ordinal": toolOrdinals[toolCallId],
			})
		case "compaction_start":
			compacting = true
			gate.SetPurpose("compaction")
			reason, _ := event["reason"].(string)
			store.Event(operation.TaskId, "session.compaction_started", map[string]any{
				"nodeId": operation.NodeId, "operationId": operation.Id, "reason": reason,
			})
		case "compaction_end":
			compacting = false
			gate.SetPurpose("completion")
			aborted, _ := event["aborted"].(bool)
			result, _ := event["result"].(map[string]any)
			reason, _ := event["reason"].(string)
			if !aborted && result != nil {
				tokensBefore := result["tokensBefore"]
				completionSequence := piAdapterCompletionSequence(store, instanceId)
				data := map[string]any{
					"reason": reason, "operationId": operation.Id, "tokensBefore": tokensBefore,
					"completionSequence": completionSequence,
				}
				if estimated, ok := result["estimatedTokensAfter"]; ok {
					data["tokensAfter"] = estimated
				}
				summary, _ := result["summary"].(string)
				if persistEntries {
					AppendNodeEntry(store, NodeEntryInput{
						TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
						ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "system", Kind: "compaction",
						Text: summary, Data: data,
					})
				}
				// A conversation keeps its messages untouched; the compaction is
				// reported as a session event instead of overwriting history.
				store.Event(operation.TaskId, "session.compacted", map[string]any{"nodeId": operation.NodeId, "data": data})
				return
			}
			// Pi's own threshold/overflow compaction can fail without throwing
			// (a summarizer that hits its output cap). Record it so the failure
			// is visible instead of silently leaving the context oversized.
			errorMessage, _ := event["errorMessage"].(string)
			if errorMessage == "" {
				errorMessage = "compaction aborted"
			}
			kind := "session.compaction_failed"
			if IsCompactionNoop(errorMessage) {
				kind = "session.compaction_skipped"
			}
			store.Event(operation.TaskId, kind, map[string]any{
				"nodeId": operation.NodeId, "operationId": operation.Id, "reason": reason, "error": errorMessage,
			})
		}
	}
	return piAdapterRunTurn(options, transport, input, piAdapterTurnInput{
		Gate: gate, ObservedGate: observedGate, Spec: spec, Conversation: conversation, Workspace: workspace,
		PermissionRequest: permissionRequest, AskedQuestion: askedQuestion, ReloadReceipt: &reloadReceipt,
		CapabilityOperation: capabilityOperation, ContextAssembly: contextAssembly, Commands: commands,
		Tools: tools, ThinkingLevel: thinkingLevel, ModelPolicyDigest: modelPolicyDigest,
		ToolPolicyDigest: toolPolicyDigest, ComposedPrompt: composedPrompt, AgentContext: agentContext,
		OnEvent: onEvent, Parts: parts, PartsOrder: partsOrder, FlushDeltas: flushDeltas,
		ToolSummaries: toolSummaries, ToolActivity: &toolActivity, Activity: &activity,
		NarrationByEntry: narrationByEntry, ToolOrdinals: toolOrdinals, ActiveConversationTools: activeConversationTools,
		PersistEntries: persistEntries, SawAssistantMessageEnd: &sawAssistantMessageEnd, Compacting: &compacting,
		GateRefusal: &gateRefusal, Retrieval: retrieval, ArtifactService: artifactService, Role: role,
		NextOrdinal: nextOrdinal,
	})
}

// piAdapterTurnInput is the state one turn runs with.
type piAdapterTurnInput struct {
	Gate                    *TaskSendGate
	ObservedGate            SendGate
	Spec                    NodeSpec
	Conversation            *ConversationRow
	Workspace               string
	PermissionRequest       *CapabilityPermissionRequest
	AskedQuestion           *PiAdapterAskedQuestion
	ReloadReceipt           *map[string]any
	CapabilityOperation     CapabilityOperation
	ContextAssembly         *AgentContextAssembly
	Commands                *WorkspaceCommandRunner
	Tools                   []ToolDefinition
	ThinkingLevel           string
	ModelPolicyDigest       string
	ToolPolicyDigest        string
	ComposedPrompt          string
	AgentContext            *ResolvedAgentContext
	OnEvent                 func(event map[string]any)
	Parts                   map[string]*piAdapterPart
	PartsOrder              []string
	FlushDeltas             func(force bool)
	ToolSummaries           map[string]string
	ToolActivity            *[]PiAdapterToolActivity
	Activity                *[]PiAdapterActivityRecord
	NarrationByEntry        map[string]*PiAdapterActivityRecord
	ToolOrdinals            map[string]int
	ActiveConversationTools map[string]bool
	PersistEntries          bool
	SawAssistantMessageEnd  *bool
	Compacting              *bool
	GateRefusal             *error
	Retrieval               *RetrievalBroker
	ArtifactService         *PiAdapterArtifactService
	Role                    string
	NextOrdinal             func() int
}

// piAdapterPart is one live text part of one assistant message.
type piAdapterPart struct {
	entryId   string
	partId    string
	text      string
	buffer    string
	lastFlush int64
	ordinal   int
}

// PiAdapterToolActivity is one executed tool call in the turn record.
type PiAdapterToolActivity struct {
	ToolCallId string `json:"toolCallId"`
	Name       string `json:"name"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
}

// PiAdapterActivityRecord is one ordered turn activity entry.
type PiAdapterActivityRecord struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	ToolCallId string `json:"toolCallId,omitempty"`
	Name       string `json:"name,omitempty"`
	Summary    string `json:"summary,omitempty"`
	State      string `json:"state,omitempty"`
	Ordinal    int    `json:"ordinal"`
}

// PiAdapterAskedQuestion is the agent's own question to the user.
type PiAdapterAskedQuestion struct {
	Prompt   string   `json:"prompt"`
	Why      string   `json:"why"`
	Options  []string `json:"options"`
	Multiple bool     `json:"multiple"`
}

// piAdapterRunTurn opens the session, sends the prompt and settles the operation.
func piAdapterRunTurn(options PiAdapterOptions, transport AgentSessionTransport, input piAdapterRunInput, turn piAdapterTurnInput) OperationResult {
	operation := input.Operation
	entry := input.Entry
	store := options.Store
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	// Context size comes from the last billed completion for this
	// instance, so Graph can compact before the window is exceeded
	// instead of waiting for a provider overflow.
	lastContextTokens := piAdapterLastContextTokens(store, operation.TaskId, instanceId)
	// The skills the session may read must match the block Graph renders: the bound
	// snapshots plus the SDK's own global and project folders.
	skillReadPaths := piAdapterUnique(append(append([]string{}, turn.CapabilityOperation.SkillPaths...),
		NativeSkillDirs([]string{turn.Workspace, input.ProjectRoot}, "", "")...))
	request := AgentSessionRequest{
		ExecutionConfiguration: map[string]any{"model": entry, "spec": turn.Spec, "accessPolicy": input.AccessPolicy},
		CapabilityDescriptor:   turn.CapabilityOperation.Descriptor,
		CredentialReference:    map[string]any{"modelId": entry.Id, "provider": entry.Provider, "credentialId": entry.CredentialId},
		ExecutionId:            operation.Id, InputRequestId: fmt.Sprintf("%s:attempt:%d", operation.Id, operation.Attempt),
		Binding: AgentSessionBinding{
			InstanceId: instanceId, NodeId: operation.NodeId, DefinitionVersion: input.DefinitionVersion,
		},
		// Durable telemetry for every tool call this instance executes, Graph's and Pi's alike.
		// The write is guarded here: a statistics table must never be able to break a turn.
		OnToolCall: func(call PiAdapterToolCall) {
			defer func() { _ = recover() }()
			target := any(nil)
			if call.Target != nil {
				target = call.Target
			}
			store.RecordToolCall(ToolCallInput{
				InstanceID: instanceId, Tool: call.Tool, Ms: call.Ms, IsError: call.IsError, Target: target,
			})
		},
		Workspace: turn.Workspace,
		StateDir:  filepath.Join(options.InstancesDir, instanceId),
		Model:     ToPiModel(entry),
		Stream: GuardHandoffResponses(
			ControlledOpenAIStream(turn.ObservedGate, entry, input.ResolveKeyFor, input.SlotFor, entry.Api, PiAdapterStreamOptions{
				EstimateMissing: UnknownUsageIsNonBlocking(store, instanceId),
				OnRequest: func(callId string, profile map[string]any) {
					data := map[string]any{
						"callId": callId, "operationId": operation.Id, "instanceId": instanceId, "model": entry.Id,
						"rates": nil, "pricing": nil,
					}
					if entry.Cost != nil {
						data["rates"] = entry.Cost
					}
					if entry.Pricing != nil {
						data["pricing"] = entry.Pricing
					}
					for key, value := range profile {
						data[key] = value
					}
					store.Event(operation.TaskId, "provider.request_profile", data)
				},
				OnSend: func(sent PiAdapterSentRequest) {
					if sent.SystemPrompt != nil {
						store.RecordOperationSystemPrompt(operation.Id, *sent.SystemPrompt, sent.ToolDeclarations)
					}
					// The site that records the truth also reports when a part of it is
					// gone: reporting only, a send is never blocked or rewritten.
					ReportPromptIntegrity(filepath.Join(options.InstancesDir, instanceId), operation.Id, sent.SystemPrompt, nil)
				},
			}),
			func() bool { return turn.Conversation != nil && !*turn.Compacting },
			func(status string) {
				store.Event(operation.TaskId, "session.handoff_response", map[string]any{
					"operationId": operation.Id, "nodeId": operation.NodeId, "status": status,
				})
			},
		),
		ThinkingLevel:    stringPointer(turn.ThinkingLevel),
		Tools:            turn.Tools,
		AllowedToolNames: append([]string{}, turn.CapabilityOperation.AllowedToolNames...),
		SkillPaths:       skillReadPaths,
		SkillFolder:      turn.CapabilityOperation.SkillFolder,
		ReadRoots:        append([]string{}, turn.CapabilityOperation.ReadRoots...),
		WriteRoots:       append([]string{}, turn.CapabilityOperation.WriteRoots...),
		Env:              turn.CapabilityOperation.Env,
		NetworkDomains:   append([]string{}, turn.CapabilityOperation.NetworkDomains...),
		AllowUnrestrictedNetwork: turn.CapabilityOperation.AllowUnrestrictedNetwork ||
			(input.AccessPolicy != nil && input.AccessPolicy.Network == "unrestricted"),
		AllowLocalBinding: turn.CapabilityOperation.AllowLocalBinding ||
			(input.AccessPolicy != nil && input.AccessPolicy.PiExtensions.LocalBinding),
		UnixSockets:            append([]string{}, turn.CapabilityOperation.UnixSockets...),
		AllowAllUnixSockets:    input.AccessPolicy != nil && input.AccessPolicy.PiExtensions.UnixSockets == "all",
		AllowAppleEvents:       input.AccessPolicy != nil && input.AccessPolicy.PiExtensions.AppleEvents,
		PiExtensionPaths:       append([]string{}, turn.CapabilityOperation.PiExtensionPaths...),
		McpAdapterServers:      append([]McpAdapterServerRef{}, turn.CapabilityOperation.McpAdapterServers...),
		PiExtensionTools:       append([]string{}, turn.CapabilityOperation.PiExtensionTools...),
		SystemPrompt:           turn.ComposedPrompt,
		BundleDigest:           turn.CapabilityOperation.BundleDigest,
		LegacyCapabilityDigest: stringPointer(turn.CapabilityOperation.LegacyPromptDigest),
		ToolPolicyDigest:       turn.CapabilityOperation.ToolPolicyDigest,
		RuntimePolicyDigest:    turn.CapabilityOperation.RuntimePolicyDigest,
		Broker:                 turn.ObservedGate,
		NativeTools:            append([]string{}, turn.CapabilityOperation.NativeTools...),
		AllowWorkspaceChange:   turn.Conversation != nil,
		// Auto-compaction stays on for workers, reviewers and the master;
		// thresholds follow the model that will receive the summary.
		Compaction: piAdapterCompactionSettings(entry),
		OnEvent:    turn.OnEvent,
	}
	if input.AccessPolicy != nil {
		filesystemAccess := "bounded"
		if input.AccessPolicy.Filesystem.Read == "host" || input.AccessPolicy.Filesystem.Write == "host" {
			filesystemAccess = "host"
		}
		request.FilesystemAccess = filesystemAccess
		request.ProtectedPaths = input.AccessPolicy.ProtectedPaths
		request.AllowGitMetadataWritesAll = input.AccessPolicy.Filesystem.GitMetadata == "writable"
	}
	if turn.AgentContext != nil && turn.AgentContext.ReviewPolicy != nil {
		request.FreshSession = true
	}
	if options.RecoverySnapshot != nil {
		snapshot := asMap(options.RecoverySnapshot["snapshot"])
		policy := asMap(options.RecoverySnapshot["restoredPolicy"])
		request.SystemPrompt = mapString(asMap(snapshot["agent"]), "instructions")
		request.Model = snapshot["model"]
		request.Workspace = mapString(policy, "workspace")
		request.StateDir = mapString(policy, "stateDir")
		request.InputRequestId = mapString(snapshot, "inputRequestId")
		request.SkillPaths = durableStrings(policy["skillPaths"])
		request.SkillFolder = mapString(policy, "skillFolder")
		request.PiExtensionPaths = durableStrings(policy["piExtensionPaths"])
		request.ReadRoots = durableStrings(policy["readRoots"])
		request.WriteRoots = durableStrings(policy["writeRoots"])
		request.ProtectedPaths = durableStrings(policy["protectedPaths"])
		request.CapabilityDescriptor = asMap(options.RecoverySnapshot["restoredDescriptor"])
		configuration := asMap(snapshot["configuration"])
		request.ExecutionConfiguration = configuration["executionConfiguration"]
		request.CredentialReference = configuration["credentialReference"]
	}
	session, err := transport.Open(request)
	if err != nil {
		panic(err)
	}
	input.ActiveMu.Lock()
	(*input.ActiveInstances)[operation.Id] = session
	input.ActiveMu.Unlock()
	inspected := session.Inspect()
	if len(inspected.ExtensionErrors) > 0 {
		details := []string{}
		for _, item := range inspected.ExtensionErrors {
			details = append(details, fmt.Sprintf("%s: %v", item.Path, item.Error))
		}
		Raise("capability_unavailable", "A bound Pi extension failed to load: "+strings.Join(details, "; "))
	}
	if turn.PersistEntries {
		RecordNodeSession(store, instanceId, inspected.SessionId, inspected.SessionFile)
		if turn.AgentContext != nil {
			contextSession := PiAdapterContextSession{
				TaskId: operation.TaskId, NodeId: operation.NodeId, OperationId: operation.Id,
				BindingId: turn.AgentContext.BindingId, SessionId: inspected.SessionId,
				CapabilityDigest:  turn.CapabilityOperation.BundleDigest,
				ModelPolicyDigest: turn.ModelPolicyDigest, ToolPolicyDigest: turn.ToolPolicyDigest,
			}
			if inspected.Context != nil {
				contextSession.SourceLeafId = inspected.Context.SourceLeafId
				contextSession.SourceContextDigest = inspected.Context.SourceContextDigest
				if inspected.Context.ChildContextDigest != "" {
					childDigest := inspected.Context.ChildContextDigest
					contextSession.ChildContextDigest = &childDigest
				}
			}
			RecordContextSession(store, contextSession)
		}
	}
	defer func() {
		input.ActiveMu.Lock()
		delete(*input.ActiveInstances, operation.Id)
		input.ActiveMu.Unlock()
		if closeErr := session.Close(); closeErr != nil {
			panic(closeErr)
		}
	}()

	compactRequested := false
	for _, message := range operation.Context.Messages {
		if message.Command != nil && *message.Command == "compact" {
			compactRequested = true
			break
		}
	}
	// Graph triggers compaction itself so the bounded instructions below
	// apply. Pi's own threshold/overflow compaction stays enabled as a
	// backstop for a context Graph mis-estimated.
	autoCompact := !compactRequested && shouldCompactContextForEntry(entry, lastContextTokens)
	if compactRequested || autoCompact {
		compactionErr := session.Compact(COMPACTION_INSTRUCTIONS)
		if compactionErr == nil {
			turn.FlushDeltas(true)
			if *turn.GateRefusal != nil {
				panic(*turn.GateRefusal)
			}
			text := "上下文已压缩。"
			if turn.PersistEntries {
				AppendNodeEntry(store, NodeEntryInput{
					TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
					ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "system", Kind: "compaction",
					Text: text,
				})
			}
			if compactRequested && operation.Context.RsiContinuation == nil {
				return OperationResult{Outcome: "completed", Output: map[string]any{"text": text}, Usage: turn.Gate.Total()}
			}
		} else {
			// A summarizer that hits its output cap must not poison the
			// turn: the `compaction_end` event already recorded why, so
			// keep going (or report it for a manual request) instead of
			// failing the operation as an unknown dispatch.
			message := compactionErr.Error()
			if compactRequested && operation.Context.RsiContinuation == nil && IsCompactionNoop(message) {
				return OperationResult{Outcome: "completed", Output: map[string]any{"text": "上下文已是精简状态，无需再次压缩。"}, Usage: turn.Gate.Total()}
			}
			if compactRequested && !IsCompactionNoop(message) {
				return OperationResult{Outcome: "failed", Output: map[string]any{"error": "上下文压缩失败：" + message}, Usage: turn.Gate.Total()}
			}
		}
	}
	briefing := ""
	if operation.Context.Briefing != nil {
		briefing = *operation.Context.Briefing
	} else {
		briefing = "Continue work for " + operation.NodeId
	}
	if turn.PersistEntries {
		AppendNodeEntry(store, NodeEntryInput{
			TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
			ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "user", Kind: "briefing",
			Text: truncateRunes(briefing, 20_000),
		})
	}
	attachments := []AttachmentInput{}
	for _, message := range operation.Context.Messages {
		attachments = append(attachments, message.Attachments...)
	}
	userImages := PromptImagesFromAttachments(attachments)
	// A bound skill is knowledge the model cannot call, and a `disable-model-invocation`
	// skill is not in the system prompt at all: the only way its body reaches a turn is
	// the user selecting it. Only this turn's own messages are read for the token - a
	// briefing keeps an earlier turn as standing context and would re-inject it forever.
	turnTexts := []string{}
	for _, message := range operation.Context.Messages {
		if strings.TrimSpace(message.Text) != "" {
			turnTexts = append(turnTexts, message.Text)
		}
	}
	turnText := strings.Join(turnTexts, "\n")
	skillSource := turnText
	if skillSource == "" {
		skillSource = briefing
	}
	skillInjection := InjectRequestedSkills(briefing, piAdapterBoundSkills(turn.ContextAssembly.Bundle.Facts, options.Catalog), RequestedSkillNames(skillSource))
	if len(skillInjection.Injected) > 0 || len(skillInjection.Rejected) > 0 {
		func() {
			defer func() { _ = recover() }()
			store.Event(operation.TaskId, "skill.invoked", map[string]any{
				"operationId": operation.Id, "nodeId": operation.NodeId,
				"injected": skillInjection.Injected, "rejected": skillInjection.Rejected,
			})
		}()
	}
	result, err := session.Prompt(skillInjection.Text, userImages)
	if err != nil {
		panic(err)
	}
	turn.FlushDeltas(true)
	if *turn.GateRefusal != nil {
		panic(*turn.GateRefusal)
	}
	// A provider or transport error ends the turn with an assistant
	// error message; that is a failure, never a successful operation.
	if result.StopReason != nil && *result.StopReason == "error" {
		message := "Model request failed"
		if result.ErrorMessage != nil {
			message = *result.ErrorMessage
		}
		return OperationResult{Outcome: "failed", Output: map[string]any{"error": message}, Usage: turn.Gate.Total()}
	}
	if result.StopReason != nil && *result.StopReason == "aborted" {
		Raise("interrupted", "用户打断了当前模型思考或工具调用")
	}
	if result.StopReason != nil && *result.StopReason == "length" {
		return OperationResult{
			Outcome: "failed",
			Output:  map[string]any{"error": "Model response hit the output token limit before completing the reply"},
			Usage:   turn.Gate.Total(),
		}
	}
	// An explicit question from the agent ends the turn: the answer is the next
	// turn's input, so waiting costs no further model requests.
	if turn.AskedQuestion != nil {
		question := *turn.AskedQuestion
		return OperationResult{
			Outcome:  "waiting",
			Output:   map[string]any{"question": question},
			Question: &OperationQuestion{Prompt: question.Prompt, Data: map[string]any{"requestType": "user_decision", "prompt": question.Prompt, "why": question.Why, "options": question.Options, "multiple": question.Multiple}},
			Usage:    turn.Gate.Total(),
		}
	}
	if turn.PermissionRequest != nil {
		request := *turn.PermissionRequest
		return OperationResult{
			Outcome: "waiting",
			Output: map[string]any{"permission": map[string]any{
				"grant": request.Grant, "capabilityId": request.CapabilityId, "tool": request.Tool,
			}},
			Question: &OperationQuestion{
				Prompt: "Remote MCP tool " + request.Tool + " requires the user grant " + request.Grant + " in this task",
				Grant:  stringPointer(request.Grant),
			},
			Usage: turn.Gate.Total(),
		}
	}
	text := result.FinalAssistantText
	reply := text
	if strings.TrimSpace(reply) == "" {
		pieces := []string{}
		for _, key := range turn.PartsOrder {
			pieces = append(pieces, turn.Parts[key].text)
		}
		reply = strings.Join(pieces, "")
	}
	turn.FlushDeltas(true)
	if turn.Conversation != nil && IsLeakedCompactionReply(reply) {
		repeated := IsSummaryLeakRetry(operation.Context.PreviousOutput)
		store.Event(operation.TaskId, "session.summary_leaked_as_reply", map[string]any{
			"operationId": operation.Id, "nodeId": operation.NodeId, "repeated": repeated, "chars": len([]rune(reply)),
		})
		outcome := "continue"
		message := "模型将内部会话摘要作为普通回复，正在自动续行。"
		if repeated {
			outcome = "failed"
			message = "模型连续两轮将内部会话摘要作为普通回复，已停止自动重试。"
		}
		return OperationResult{
			Outcome: outcome,
			Output:  map[string]any{"retryCode": "session_summary_leak", "error": message},
			Usage:   turn.Gate.Total(),
		}
	}
	if turn.PersistEntries && !*turn.SawAssistantMessageEnd && strings.TrimSpace(reply) != "" {
		AppendNodeEntry(store, NodeEntryInput{
			TaskID: operation.TaskId, NodeID: operation.NodeId, InstanceID: instanceId,
			ActivationID: operation.ActivationId, OperationID: operation.Id, Role: "assistant", Kind: "message", Text: reply,
		})
	}
	var suggestedPrompt *string
	var suggestionUsage *TokenUsage
	var suggestionReply *PromptSuggestionReply
	suggestionTimeoutMs := PROMPT_SUGGESTION_TIMEOUT_MS
	if os.Getenv("GRAPH_EXTENDED_PROMPT_SUGGESTION_TIMEOUT") == "1" {
		suggestionTimeoutMs = 20_000
	}
	suggestionTimedOut := false
	lastUserMessage := ""
	for i := len(operation.Context.Messages) - 1; i >= 0; i-- {
		if strings.TrimSpace(operation.Context.Messages[i].Text) != "" {
			lastUserMessage = operation.Context.Messages[i].Text
			break
		}
	}
	var suggestionEntry *ModelEntry
	if turn.Conversation != nil && lastUserMessage != "" {
		suggestionEntry = SelectPromptSuggestionModel(entry, options.Directory())
	}
	if suggestionEntry != nil && strings.TrimSpace(reply) != "" {
		suggestionNodeId := operation.NodeId
		suggestionGate := TaskGate(store, TaskGateOperation{
			Id: operation.Id, TaskId: operation.TaskId, InstanceId: instanceId, NodeId: &suggestionNodeId,
		}, *suggestionEntry, TaskGateOptions{Optional: true})
		suggestionGate.SetPurpose("prompt_suggestion")
		signal := NewAbortSignal()
		timer := time.AfterFunc(time.Duration(suggestionTimeoutMs)*time.Millisecond, func() {
			suggestionTimedOut = true
			signal.Abort()
		})
		suggestionReply = piAdapterGenerateSuggestion(options, *suggestionEntry, suggestionGate, input, lastUserMessage, reply, signal)
		timer.Stop()
		if suggestionReply.Text != "" {
			suggested := suggestionReply.Text
			suggestedPrompt = &suggested
		}
		suggestionUsage = suggestionGate.Total()
	}
	// A failed call and a model that had nothing to suggest used to collapse into the same
	// silent `undefined`. The decision now travels with the turn, with the call's own words.
	if turn.Conversation != nil {
		decision := map[string]any{
			"operationId": operation.Id, "nodeId": operation.NodeId, "model": nil,
			"asked":     suggestionEntry != nil && strings.TrimSpace(reply) != "",
			"timeoutMs": nil, "timedOut": suggestionTimedOut, "stopReason": nil, "error": nil,
			"chars": 0, "suggestion": "", "replyHead": "",
		}
		if suggestionEntry != nil {
			decision["model"] = suggestionEntry.Id
		}
		if suggestionEntry != nil && strings.TrimSpace(reply) != "" {
			decision["timeoutMs"] = suggestionTimeoutMs
		}
		if suggestionReply != nil {
			if suggestionReply.StopReason != nil {
				decision["stopReason"] = *suggestionReply.StopReason
			}
			if suggestionReply.Error != nil {
				decision["error"] = *suggestionReply.Error
			}
			decision["chars"] = len([]rune(suggestionReply.Raw))
			decision["suggestion"] = suggestionReply.Text
			decision["replyHead"] = truncateRunes(suggestionReply.Raw, 200)
		}
		store.Event(operation.TaskId, "prompt_suggestion.decided", decision)
	}
	// Sedimentation runs after the turn like the composer suggestion does: one extra call on
	// a cheaper model, through the same gate, and the write happens in `applySedimentProposal`
	// so it cannot escape the project's skill folder. Never allowed to break the turn.
	if turn.Conversation != nil && options.Sediment != nil {
		piAdapterRunSediment(options, input, turn, entry, reply, lastUserMessage)
	}
	// The reload handoff keeps its own output: the console shows the receipt, while the review
	// above already read the change itself.
	if turn.ReloadReceipt != nil && *turn.ReloadReceipt != nil {
		output := map[string]any{"text": RSI_RELOAD_RECEIPT, "rsiRequestId": fmt.Sprintf("%v", (*turn.ReloadReceipt)["id"])}
		if len(*turn.ToolActivity) > 0 {
			output["toolActivity"] = *turn.ToolActivity
		}
		if len(*turn.Activity) > 0 {
			output["activity"] = *turn.Activity
		}
		return OperationResult{Outcome: "completed", Output: output, Usage: turn.Gate.Total()}
	}
	// External main returns its visible reply and recorded conversation activity.
	var output map[string]any
	if turn.Conversation != nil {
		output = map[string]any{"text": reply}
		if suggestedPrompt != nil {
			output["suggestedPrompt"] = *suggestedPrompt
		}
		if len(*turn.ToolActivity) > 0 {
			output["toolActivity"] = *turn.ToolActivity
		}
		if len(*turn.Activity) > 0 {
			output["activity"] = *turn.Activity
		}
	} else {
		output = map[string]any{"text": reply}
	}
	return OperationResult{Outcome: "completed", Output: output, Usage: combineKnownUsage(turn.Gate.Total(), suggestionUsage)}
}

// piAdapterAssistantText is the text of an assistant message, whatever shape its content has.
//
// Since 0.86 a system or user message carries plain string content
// (types.d.ts: content: string | TextContent[]), so the role has to be
// checked before the array shape is assumed.
func piAdapterAssistantText(message map[string]any) string {
	if message == nil {
		return ""
	}
	role, _ := message["role"].(string)
	if role != "assistant" {
		return ""
	}
	switch content := message["content"].(type) {
	case string:
		return content
	case []any:
		pieces := []string{}
		for _, item := range content {
			part, _ := item.(map[string]any)
			if part["type"] != "text" {
				continue
			}
			text, ok := part["text"].(string)
			if !ok {
				continue
			}
			pieces = append(pieces, text)
		}
		return strings.Join(pieces, "")
	}
	return ""
}

// piAdapterUnique keeps the first occurrence of every path.
func piAdapterUnique(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

// truncateRunes keeps the first n runes of a string.
func truncateRunes(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n])
}

// asError turns a recovered panic value into an error.
func asError(rec any) error {
	if err, ok := rec.(error); ok {
		return err
	}
	return errors.New(fmt.Sprintf("%v", rec))
}

// asFloatValue reads a number out of a decoded JSON value.
func asFloatValue(value any) float64 {
	number, ok := asFloat(value)
	if !ok {
		return 0
	}
	return number
}

// piAdapterNullableString maps an empty string to a null JSON value.
func piAdapterNullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// agentContextRoot is the context root of the prompt library, when it has one.
func agentContextRoot(library *AgentContextLibrary) string {
	if library == nil {
		return ""
	}
	return library.ContextRoot
}

// PiAdapterArtifactService is the artifact surface one operation may use.
type PiAdapterArtifactService struct {
	Access  any
	List    func(query ArtifactQuery) ArtifactPage
	Get     func(artifactId string, version *int) ArtifactRecord
	Read    func(artifactId string, version int, maxBytes int) ArtifactRead
	Publish func(input PublishArtifactInput) ArtifactRecord
	Retire  func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	Promote func(input ArtifactPromoteInput) ArtifactRecord
}

// piAdapterArtifactService is the artifact surface one operation may use.
func piAdapterArtifactService(options PiAdapterOptions, input piAdapterRunInput, spec NodeSpec, workspace string, role string) *PiAdapterArtifactService {
	if options.Artifacts == nil {
		return nil
	}
	operation := input.Operation
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	service := &PiAdapterArtifactService{
		Access: AgentArtifactAccessFor(struct {
			Role   string
			Action string
		}{Role: role, Action: spec.Action}),
		List: func(query ArtifactQuery) ArtifactPage {
			query.TaskId = operation.TaskId
			return options.Artifacts.List(query)
		},
		Get: func(artifactId string, version *int) ArtifactRecord {
			return options.Artifacts.Get(operation.TaskId, artifactId, version, "task")
		},
		Read: func(artifactId string, version int, maxBytes int) ArtifactRead {
			return options.Artifacts.Read(operation.TaskId, artifactId, version, maxBytes, "task")
		},
		Publish: func(publish PublishArtifactInput) ArtifactRecord {
			publish.TaskId = operation.TaskId
			publish.Workspace = workspace
			publish.Producer = ArtifactProducer{
				NodeId: operation.NodeId, InstanceId: instanceId, OperationId: operation.Id, ActivationId: operation.ActivationId,
			}
			return options.Artifacts.Publish(publish)
		},
		Retire: func(artifactId string, version int, reason string, requestId string) ArtifactRecord {
			return options.Artifacts.Retire(operation.TaskId, artifactId, version, reason, requestId, map[string]any{
				"nodeId": operation.NodeId, "instanceId": instanceId, "operationId": operation.Id, "activationId": operation.ActivationId,
			})
		},
		Promote: func(promote ArtifactPromoteInput) ArtifactRecord {
			promote.TaskId = operation.TaskId
			promote.PromotedBy = input.DefinitionVersion
			return options.Artifacts.Promote(promote)
		},
	}
	return service
}

// piAdapterCompletionSequence is the last completion sequence number of one instance.
func piAdapterCompletionSequence(store *TaskStore, instanceId string) int64 {
	row, _ := graphDBRow(store.Db, "SELECT COALESCE(MAX(rowid),0) AS sequence FROM invocations WHERE instance_id=? AND purpose='completion'", instanceId)
	return graphDBInt(row, "sequence")
}

// piAdapterLastContextTokens resolves the context size the next turn will send.
func piAdapterLastContextTokens(store *TaskStore, taskId string, instanceId string) *float64 {
	rows := graphDBAll(store.Db, `SELECT i.rowid AS sequence, i.usage, COALESCE(o.settled_at, o.dispatched_at, 0) AS settled_at
       FROM invocations i
       JOIN operations o ON o.id = i.operation_id
       WHERE i.instance_id = ? AND i.purpose = 'completion' AND i.usage IS NOT NULL
       ORDER BY i.rowid DESC LIMIT 20`, instanceId)
	completions := []RecordedContextUsage{}
	for _, row := range rows {
		sequence := asFloatValue(row["sequence"])
		usage, _ := row["usage"].(string)
		settled := asFloatValue(row["settled_at"])
		completions = append(completions, RecordedContextUsage{Usage: usage, SettledAt: settled, Sequence: &sequence})
	}
	var compaction *RecordedCompaction
	last, ok := graphDBRow(store.Db, `SELECT e.timestamp, e.data
       FROM events e
       JOIN operations o ON o.id = json_extract(e.data, '$.operationId')
       WHERE e.task_id = ? AND e.type = 'session.compacted' AND o.instance_id = ?
       ORDER BY e.cursor DESC LIMIT 1`, taskId, instanceId)
	if ok {
		timestamp := asFloatValue(last["timestamp"])
		data, _ := last["data"].(string)
		compaction = &RecordedCompaction{Timestamp: timestamp, Data: data}
	}
	return LatestContextTokens(completions, compaction)
}

// compactionSettingsForEntry derives the compaction thresholds of one model.
func piAdapterCompactionSettings(entry ModelEntry) *CompactionSettings {
	settings := CompactionSettingsFor(struct {
		ContextWindow int
		MaxTokens     int
	}{ContextWindow: entry.ContextWindow, MaxTokens: entry.MaxTokens})
	return &settings
}

// shouldCompactContextForEntry reports whether the context is already too large to send.
func shouldCompactContextForEntry(entry ModelEntry, contextTokens *float64) bool {
	return ShouldCompactContext(struct {
		ContextWindow int
		MaxTokens     int
	}{ContextWindow: entry.ContextWindow, MaxTokens: entry.MaxTokens}, contextTokens)
}

// piAdapterGenerateSuggestion asks one fresh model call for a composer line.
func piAdapterGenerateSuggestion(options PiAdapterOptions, entry ModelEntry, gate *TaskSendGate, input piAdapterRunInput, userMessage string, reply string, signal *AbortSignal) *PromptSuggestionReply {
	store := options.Store
	operation := input.Operation
	systemPrompt := DEFAULT_PROMPT_SUGGESTION_PROMPT
	if options.Channels != nil && options.Channels.AgentContext != nil {
		if prompt, err := options.Channels.AgentContext.Prompt("runtime/prompt-suggestion.md"); err == nil && prompt != "" {
			systemPrompt = prompt
		}
	}
	answer := GeneratePromptSuggestion(struct {
		Stream         PromptStreamFunc
		Model          any
		UserMessage    string
		AssistantReply string
		SystemPrompt   string
		Signal         any
	}{
		Stream: ControlledOpenAIStream(piAdapterGateSendGate(gate), entry, input.ResolveKeyFor, input.SlotFor, entry.Api, PiAdapterStreamOptions{
			EstimateMissing: true,
			OnRequest: func(callId string, profile map[string]any) {
				data := map[string]any{
					"callId": callId, "operationId": operation.Id, "model": entry.Id, "rates": nil, "pricing": nil,
				}
				if entry.Cost != nil {
					data["rates"] = entry.Cost
				}
				if entry.Pricing != nil {
					data["pricing"] = entry.Pricing
				}
				for key, value := range profile {
					data[key] = value
				}
				store.Event(operation.TaskId, "provider.request_profile", data)
			},
		}),
		Model:          ToPiModel(entry),
		UserMessage:    userMessage,
		AssistantReply: reply,
		SystemPrompt:   WithAgentTestingPolicy(systemPrompt, DEFAULT_PROMPT_SUGGESTION_PROMPT),
		Signal:         signal,
	})
	return &answer
}

// piAdapterRunSediment runs the post-operation skill review. It never breaks the turn.
func piAdapterRunSediment(options PiAdapterOptions, input piAdapterRunInput, turn piAdapterTurnInput, entry ModelEntry, reply string, lastUserMessage string) {
	store := options.Store
	operation := input.Operation
	instanceId := ""
	if operation.InstanceId != nil {
		instanceId = *operation.InstanceId
	}
	settings := options.Sediment()
	if !settings.Enabled {
		return
	}
	sedimentEntry := SelectSedimentModel(entry, options.Directory(), settings.Model)
	if sedimentEntry == nil {
		return
	}
	// What this operation itself did. Counting rows in `tool_calls` instead would make the
	// review wait for somebody to open the statistics page.
	toolCalls := len(*turn.ToolActivity)
	material := reply
	if turn.ReloadReceipt != nil && *turn.ReloadReceipt != nil {
		material = RsiChangeMaterial(*turn.ReloadReceipt, reply)
	}
	payload := map[string]any{
		"lastUserMessage": lastUserMessage,
		// An activation turn carries no assistant reply; the change it applied is the material,
		// so the review reads what the turn did instead of an empty string.
		"reply":          truncateRunes(material, 8_000),
		"existingSkills": ExistingSkillSummaries(input.ProjectRoot),
	}
	sedimentSystemPrompt := DEFAULT_SEDIMENT_PROMPT
	if options.Channels != nil && options.Channels.AgentContext != nil {
		if prompt, err := options.Channels.AgentContext.Prompt("runtime/sediment.md"); err == nil && prompt != "" {
			sedimentSystemPrompt = prompt
		}
	}
	sedimentSystemPrompt = WithAgentTestingPolicy(sedimentSystemPrompt, DEFAULT_SEDIMENT_PROMPT)
	// A cheap model is exactly the one whose account can be out of quota, so a refusal is not
	// the end of the review: candidates are asked in order and every attempt is kept, so the
	// record can never show a single silent failure as if it were a decision.
	candidates := SedimentCandidates(entry, options.Directory(), settings.Model)
	attempts := []map[string]any{}
	var answered *string
	var capture *SedimentReply
	defer func() {
		if rec := recover(); rec != nil {
			// A review is an observer of the operation, never a step in it.
			_ = rec
		}
	}()
	sedimentRole := "master"
	decision := RunSedimentReview(SedimentGate{
		Enabled: true, Role: &sedimentRole, ToolCalls: toolCalls,
		Threshold: settings.AfterToolCalls, Paused: store.Task(operation.TaskId).Paused != 0,
		// This block runs once per settled operation, so a second look is impossible here.
		AlreadyReviewed: false,
	}, settings, input.ProjectRoot, func() *string {
		for _, candidate := range candidates {
			candidateNodeId := operation.NodeId
			candidateGate := TaskGate(store, TaskGateOperation{
				Id: operation.Id, TaskId: operation.TaskId, InstanceId: instanceId, NodeId: &candidateNodeId,
			}, candidate, TaskGateOptions{Optional: true})
			candidateGate.SetPurpose("skill_sediment")
			candidateReply := GenerateSkillProposal(
				func(model any, context map[string]any, streamOptions map[string]any) (map[string]any, error) {
					stream, err := ControlledOpenAIStream(piAdapterGateSendGate(candidateGate), candidate, input.ResolveKeyFor, input.SlotFor, candidate.Api, PiAdapterStreamOptions{
						EstimateMissing: true,
						OnRequest: func(callId string, profile map[string]any) {
							data := map[string]any{
								"callId": callId, "operationId": operation.Id, "model": candidate.Id, "rates": nil, "pricing": nil,
							}
							if candidate.Cost != nil {
								data["rates"] = candidate.Cost
							}
							if candidate.Pricing != nil {
								data["pricing"] = candidate.Pricing
							}
							for key, value := range profile {
								data[key] = value
							}
							store.Event(operation.TaskId, "provider.request_profile", data)
						},
					})(model, context, streamOptions)
					if err != nil {
						return nil, err
					}
					return stream.Result(), nil
				},
				ToPiModel(candidate), sedimentSystemPrompt, payload, nil)
			copied := candidateReply
			capture = &copied
			attempt := map[string]any{"model": candidate.Id, "stopReason": nil, "error": nil, "chars": len([]rune(candidateReply.Raw))}
			if candidateReply.StopReason != nil {
				attempt["stopReason"] = *candidateReply.StopReason
			}
			if candidateReply.Error != nil {
				attempt["error"] = *candidateReply.Error
			}
			attempts = append(attempts, attempt)
			// An account that is out of quota can answer with an empty message that still says
			// "stop": only usable text ends the walk, or the review stops at the refusal.
			usable := ""
			if candidateReply.Text != nil {
				usable = strings.TrimSpace(*candidateReply.Text)
			}
			if usable != "" {
				answered = &candidate.Id
				return &usable
			}
		}
		return nil
	})
	// What the review decided travels with the operation, so "it ran and found nothing",
	// "it proposed and was refused", "it never came back with anything readable" and "every
	// cheap account refused it" are facts in the store instead of guesses.
	model := ""
	if answered != nil {
		model = *answered
	} else if len(candidates) > 0 {
		model = candidates[0].Id
	} else {
		model = sedimentEntry.Id
	}
	record := map[string]any{
		"operationId": operation.Id, "nodeId": operation.NodeId, "model": model, "toolCalls": toolCalls,
		"threshold": settings.AfterToolCalls, "reviewed": decision.Reviewed, "proposed": decision.Outcome.Proposed,
		"written": decision.Outcome.Written, "refused": decision.Outcome.Refused, "attempts": attempts,
		"replyShape": nil, "replyStop": nil, "replyChars": 0, "replyHead": "", "replyError": nil,
	}
	if capture != nil {
		shape := SedimentReplyShapeOf(capture.Raw)
		record["replyShape"] = shape
		if capture.StopReason != nil {
			record["replyStop"] = *capture.StopReason
		}
		record["replyChars"] = len([]rune(capture.Raw))
		record["replyHead"] = truncateRunes(capture.Raw, 200)
		if capture.Error != nil {
			record["replyError"] = *capture.Error
		}
	}
	store.Event(operation.TaskId, "skill_sediment.reviewed", record)
}

// piAdapterGateSendGate is the send gate a task gate offers to the provider transport.
func piAdapterGateSendGate(gate *TaskSendGate) SendGate {
	return gate.SendGate
}

// PiAdapterStreamOptions are the provider transport's own switches.
type PiAdapterStreamOptions struct {
	// EstimateMissing reports a missing usage report as an estimate instead of a failure.
	EstimateMissing bool
	// OnRequest records the request profile of one provider call.
	OnRequest func(callId string, profile map[string]any)
	// OnSend observes what the transport is about to send.
	OnSend func(sent PiAdapterSentRequest)
}

// PiAdapterSentRequest is what the transport is about to send.
type PiAdapterSentRequest struct {
	SystemPrompt     *string
	ToolDeclarations any
}

// PiAdapterToolCall is one executed tool call, as the session reports it.
type PiAdapterToolCall struct {
	Tool    string
	Ms      float64
	IsError bool
	Target  *string
}

// PiAdapterContextSession is the context session a node records.
type PiAdapterContextSession struct {
	TaskId              string
	NodeId              string
	OperationId         string
	BindingId           string
	SessionId           string
	CapabilityDigest    string
	ModelPolicyDigest   string
	ToolPolicyDigest    string
	SourceLeafId        *string
	SourceContextDigest *string
	ChildContextDigest  *string
}

// PiAdapterConversationDelta is one live text delta of a conversation.
type PiAdapterConversationDelta struct {
	TaskId         string
	ConversationId string
	OperationId    string
	EntryId        string
	PartId         string
	Ordinal        int
	Delta          string
	Text           string
	Length         int
}

// PiAdapterPeerNode is one peer of the same graph.
type PiAdapterPeerNode struct {
	Id     string  `json:"id"`
	Role   *string `json:"role"`
	Status string  `json:"status"`
}

// PiAdapterPeerRequest is one message a node sends to a peer.
type PiAdapterPeerRequest struct {
	To        string `json:"to"`
	Text      string `json:"text"`
	RequestId string `json:"requestId"`
}

// PiAdapterPeerTools is the peer surface one node may use.
type PiAdapterPeerTools struct {
	List func() []PiAdapterPeerNode
	Send func(request PiAdapterPeerRequest) any
}

// piAdapterCatalogSkills adapts the catalog to the skill lookup BoundSkills needs.
type piAdapterCatalogSkills struct {
	catalog *Catalog
}

func (skills piAdapterCatalogSkills) Capability(id string, version string) *CapabilityRecord {
	if skills.catalog == nil {
		return nil
	}
	return skills.catalog.Capability(id, version)
}

// piAdapterBoundSkills are the skills a resolved capability bundle actually bound.
func piAdapterBoundSkills(facts []ResolvedCapabilityFact, catalog *Catalog) []BoundSkill {
	plain := []struct {
		Id      string
		Version string
		Kind    string
		Path    string
	}{}
	for _, fact := range facts {
		plain = append(plain, struct {
			Id      string
			Version string
			Kind    string
			Path    string
		}{Id: fact.Id, Version: fact.Version, Kind: fact.Kind, Path: fact.Path})
	}
	return BoundSkills(plain, piAdapterCatalogSkills{catalog})
}
