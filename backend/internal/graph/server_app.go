package graph

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// appBodyLimit is the JSON body ceiling. Image attachments travel as base64
// inside a chat message, so the default 1 MiB limit would reject the very
// payloads the composer can build (up to 8 MiB of images plus text). Keep a
// bounded ceiling above that.
const appBodyLimit = 24 * 1024 * 1024

// GraphApp is the HTTP application: the route table, the session guard and the
// listener. It is the Go port of the Fastify app in src/server/app.ts.
type GraphApp struct {
	logins  *providerLogins
	runtime *TaskRuntime
	options AppOptions
	session string
	handler http.Handler
	server  *http.Server

	mutex  sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}

	layoutMutex sync.Mutex
	layouts     map[string]GraphLayout
	layoutOrder []string
}

// CreateApp builds the HTTP application. The runtime is the task runtime of
// src/core/task-runtime.ts; the options carry the host services the console
// reads.
func CreateApp(runtime *TaskRuntime, options AppOptions) *GraphApp {
	app := &GraphApp{
		runtime: runtime,
		options: options,
		session: CreateSession(),
		conns:   map[net.Conn]struct{}{},
		// The layout cache is written on the first graph view, so it has to
		// exist before the first request arrives.
		layouts: map[string]GraphLayout{},
	}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.handler = app.guard(mux)
	return app
}

// ServeHTTP serves one request. The Fastify error handler became this
// recover: a RuntimeError is 400 {code,message} plus field when set.
func (app *GraphApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if recovered := recover(); recovered != nil {
			writePublic(w, recovered)
		}
	}()
	app.handler.ServeHTTP(w, r)
}

// Listen binds the console on loopback and returns its address.
func (app *GraphApp) Listen(host string, port int) (string, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return "", err
	}
	app.mutex.Lock()
	app.server = &http.Server{Handler: app}
	app.mutex.Unlock()
	go func() {
		_ = app.server.Serve(listener)
	}()
	return "http://" + listener.Addr().String(), nil
}

// Close stops the server.
func (app *GraphApp) Close() {
	app.mutex.Lock()
	server := app.server
	app.closed = true
	app.mutex.Unlock()
	if app.logins != nil {
		app.logins.close()
	}
	// The Pi extensions the daemon hosted run in processes of their own; they
	// stop with the daemon.
	ClosePigExtensions()
	if server != nil {
		_ = server.Close()
	}
}

// CloseAllConnections drops the open connections. A long-lived SSE stream
// must not keep the daemon from stopping.
func (app *GraphApp) CloseAllConnections() {
	app.mutex.Lock()
	conns := make([]net.Conn, 0, len(app.conns))
	for conn := range app.conns {
		conns = append(conns, conn)
	}
	app.mutex.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

// guard is the Fastify onRequest hook: the session cookie, the app bridge
// token and the local-origin rule.
func (app *GraphApp) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || strings.HasPrefix(path, "/assets/") || path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}
		// The desktop bridge authenticates with the per-process token written to
		// the state directory; the browser session cookie never reaches Electron.
		if strings.HasPrefix(path, "/api/app/") {
			token := r.Header.Get("x-graph-app-token")
			if app.options.AppServices == nil || token == "" || token != app.options.AppServices.AppToken {
				writeJSON(w, http.StatusForbidden, errorJSON{Code: "forbidden", Message: "App bridge token required"})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(path, "/api/") {
			Guard(app.session, r)
		}
		if origin := r.Header.Get("Origin"); origin != "" && LocalOrigin(origin) == "" {
			writeJSON(w, http.StatusForbidden, errorJSON{Code: "forbidden_origin", Message: "Local origin required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// appReadBody reads the request body under the 24 MiB JSON limit.
func appReadBody(w http.ResponseWriter, r *http.Request) []byte {
	limited := http.MaxBytesReader(w, r.Body, appBodyLimit)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			RaiseStatus(http.StatusRequestEntityTooLarge, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
		}
		panic(err)
	}
	return raw
}

// appJSONBody reads and parses the JSON body of one request.
func appJSONBody(w http.ResponseWriter, r *http.Request) map[string]any {
	raw := appReadBody(w, r)
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		RaiseStatus(http.StatusBadRequest, "FST_ERR_CTP_INVALID_JSON", "Body is not valid JSON")
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		RaiseStatus(http.StatusBadRequest, "FST_ERR_CTP_INVALID_JSON", "Body must be a JSON object")
	}
	return record
}

// appBodyString reads a string field of the JSON body.
func appBodyString(body map[string]any, field string) string {
	value, _ := body[field].(string)
	return value
}

// appBodyInt reads an integer field of the JSON body.
func appBodyInt(body map[string]any, field string) (int, bool) {
	value, ok := body[field].(float64)
	if !ok {
		return 0, false
	}
	return int(value), true
}

// appQueryNumber reads a numeric query parameter.
func appQueryNumber(r *http.Request, field string) (float64, bool) {
	raw := r.URL.Query().Get(field)
	if raw == "" {
		return 0, false
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// appQueryInt reads an integer query parameter.
func appQueryInt(r *http.Request, field string) (int, bool) {
	value, ok := appQueryNumber(r, field)
	if !ok {
		return 0, false
	}
	return int(value), true
}

// appQueryBool reads a boolean query parameter.
func appQueryBool(r *http.Request, field string) bool {
	return r.URL.Query().Get(field) == "true"
}

// appEventCursor reads the after cursor of an event stream.
func appEventCursor(r *http.Request) int {
	raw := r.URL.Query().Get("after")
	if raw == "" {
		return 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		Raise("invalid_cursor", "Invalid event cursor")
	}
	return value
}

// appConfigStore is the configuration store the console reads and writes.
func (app *GraphApp) appConfigStore() *ConfigStore {
	if app.options.ConfigStore == nil {
		return nil
	}
	store, ok := app.options.ConfigStore.(*ConfigStore)
	if !ok {
		return nil
	}
	return store
}

// appUsageService is the subscription-usage service the console reads.
func (app *GraphApp) appUsageService() UsageService {
	if app.options.Usage == nil {
		return nil
	}
	service, ok := app.options.Usage.(UsageService)
	if !ok {
		return nil
	}
	return service
}

// appAgentContextLibrary is the prompt library the console edits.
func (app *GraphApp) appAgentContextLibrary() *AgentContextLibrary {
	if app.options.AgentContext == nil {
		return nil
	}
	library, ok := app.options.AgentContext.(*AgentContextLibrary)
	if !ok {
		return nil
	}
	return library
}

// appConfigEnv is the environment the configuration store resolves secrets in.
func (app *GraphApp) appConfigEnv() map[string]string {
	env := map[string]string{}
	for key, value := range app.options.ConfigEnv {
		if value != nil {
			env[key] = *value
		}
	}
	return env
}

// appProviderSecrets is the merged secret view the provider directory reads.
// The runtime's merged view is authoritative: it already drops revoked refs
// even when the process environment still names the variable.
func (app *GraphApp) appProviderSecrets() map[string]string {
	if app.options.AppServices != nil && app.options.AppServices.CapabilityConfig != nil {
		return app.options.AppServices.CapabilityConfig.SecretValues()
	}
	return app.appConfigEnv()
}

// appProvidersView is the provider directory and the credential view.
func (app *GraphApp) appProvidersView() map[string]any {
	secrets := app.appProviderSecrets()
	credentials := map[string]ProviderCredentialView{}
	if store := app.appConfigStore(); store != nil {
		view, ok := app.recoverValue(func() any { return SanitizeProviderView(store.Snapshot().Config, secrets) })
		if ok {
			credentials = view.(ProviderView).Credentials
		}
	}
	return map[string]any{
		"platforms":   PlatformCatalogView(secrets).Platforms,
		"credentials": credentials,
	}
}

// recoverValue runs a call and reports whether it panicked.
func (app *GraphApp) recoverValue(call func() any) (result any, ok bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = nil
			ok = false
		}
	}()
	return call(), true
}

// appProbeHttp performs one probe round-trip. No secret ever reaches the reply.
func appProbeHttp(spec HttpRequestSpec) (int, any) {
	var body io.Reader
	if spec.Body != nil {
		body = strings.NewReader(*spec.Body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, spec.Method, spec.URL, body)
	if err != nil {
		return 0, err.Error()
	}
	for name, value := range spec.Headers {
		request.Header.Set(name, value)
	}
	response, err := HTTPClient.Do(request)
	if err != nil {
		return 0, err.Error()
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return response.StatusCode, ""
	}
	text := string(raw)
	if text == "" {
		return response.StatusCode, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return response.StatusCode, text
	}
	return response.StatusCode, parsed
}

// appProbeVerification is the outcome of the minimal chat request.
type appProbeVerification struct {
	OK      bool    `json:"ok"`
	Status  *int    `json:"status,omitempty"`
	Error   *string `json:"error,omitempty"`
	Skipped *bool   `json:"skipped,omitempty"`
}

// appProbeProvider is the provider a probe answered for.
type appProbeProvider struct {
	ID             string                 `json:"id"`
	Label          string                 `json:"label"`
	BaseURL        string                 `json:"baseUrl"`
	API            ModelApi               `json:"api"`
	CredentialRef  string                 `json:"credentialRef"`
	CredentialKind ProviderCredentialKind `json:"credentialKind"`
	Custom         bool                   `json:"custom"`
}

// appProbeResult is the whole probe reply.
type appProbeResult struct {
	Provider             appProbeProvider       `json:"provider"`
	CredentialConfigured bool                   `json:"credentialConfigured"`
	Models               []ProviderModelSummary `json:"models"`
	ModelsError          *string                `json:"modelsError,omitempty"`
	Verification         appProbeVerification   `json:"verification"`
}

// appRunProviderProbe probes an unsaved provider draft: always attempt the
// vendor's `/models` list (unless the body says `probeModels:false`), then send
// one minimal chat request. The `modelsListSupported` flag is copy-only - a
// vendor that really answers `/models` is never skipped because of a local
// guess, and a rejection keeps its own wording while manual model ids stay
// allowed.
func (app *GraphApp) appRunProviderProbe(body map[string]any) appProbeResult {
	parsed := ValidateProbeRequest(body)
	if !parsed.OK {
		messages := []string{}
		for _, failure := range parsed.Errors {
			messages = append(messages, failure.Field+": "+failure.Message)
		}
		Raise("invalid_input", strings.Join(messages, "; "))
	}
	request := parsed.Request
	provider := request.Provider
	secrets := app.appProviderSecrets()
	apiKey := ""
	if value, ok := secrets[provider.CredentialRef]; ok {
		apiKey = strings.TrimSpace(value)
	}
	target := ProbeTarget{BaseURL: provider.BaseURL, API: provider.API}
	if apiKey != "" {
		key := apiKey
		target.APIKey = &key
	}
	if provider.Headers != nil {
		target.Headers = provider.Headers
	}
	wantModels := ShouldProbeModels(request.ProbeModels)
	models := []ProviderModelSummary{}
	var modelsError *string
	if wantModels {
		status, payload := appProbeHttp(BuildModelsRequest(target))
		reply := ParseModelsResponse(target, status, payload)
		if reply.Error == "" {
			models = append(models, reply.Models...)
		} else {
			message := reply.Error
			modelsError = &message
		}
	}
	verifyModel := ""
	if request.ModelID != nil {
		verifyModel = *request.ModelID
	} else if len(models) > 0 {
		verifyModel = models[0].ID
	}
	verification := appProbeVerification{}
	switch {
	case apiKey == "":
		verification.OK = false
		message := "凭据未解析：" + provider.CredentialRef + "（请在环境变量或钥匙串中提供）"
		verification.Error = &message
	case verifyModel != "":
		status, payload := appProbeHttp(BuildVerifyRequest(target, verifyModel))
		reply := ParseVerifyResponse(status, payload)
		if reply.OK {
			verification.OK = true
			value := reply.Status
			verification.Status = &value
		} else {
			verification.OK = false
			value := reply.Status
			verification.Status = &value
			message := reply.Error
			verification.Error = &message
		}
	case modelsError != nil:
		verification.OK = false
		message := *modelsError
		verification.Error = &message
	default:
		verification.OK = false
		skipped := true
		verification.Skipped = &skipped
		message := "没有可验证的模型：该端点不支持模型列表，请手动添加模型 id"
		verification.Error = &message
	}
	return appProbeResult{
		Provider: appProbeProvider{
			ID: provider.ID, Label: provider.Label, BaseURL: provider.BaseURL, API: provider.API,
			CredentialRef: provider.CredentialRef, CredentialKind: provider.CredentialKind, Custom: provider.Custom,
		},
		CredentialConfigured: apiKey != "",
		Models:               models,
		ModelsError:          modelsError,
		Verification:         verification,
	}
}

// appConfigWatch is the file-watcher outcome the console reads.
type appConfigWatch struct {
	Watching     bool    `json:"watching"`
	Events       int     `json:"events"`
	Applied      int     `json:"applied"`
	Ignored      int     `json:"ignored"`
	LastEventAt  *int64  `json:"lastEventAt,omitempty"`
	LastReason   *string `json:"lastReason,omitempty"`
	FileRevision *int64  `json:"fileRevision,omitempty"`
}

// appConfigView is the configuration the console reads.
type appConfigView struct {
	Revision          int             `json:"revision"`
	EffectiveRevision *int            `json:"effectiveRevision,omitempty"`
	Configured        *bool           `json:"configured,omitempty"`
	Config            map[string]any  `json:"config"`
	PendingSecretRefs []string        `json:"pendingSecretRefs"`
	Watch             *appConfigWatch `json:"watch"`
}

// appConfigSaveResult is the outcome of one configuration save without the
// app bridge.
type appConfigSaveResult struct {
	Revision        int  `json:"revision"`
	RestartRequired bool `json:"restartRequired"`
}

// appApplyResult is the outcome of one configuration apply.
type appApplyResult struct {
	Revision          int                  `json:"revision"`
	EffectiveRevision int                  `json:"effectiveRevision"`
	Applied           bool                 `json:"applied"`
	Reason            *string              `json:"reason,omitempty"`
	Configured        bool                 `json:"configured"`
	ModelCount        int                  `json:"modelCount"`
	EnabledModelCount int                  `json:"enabledModelCount"`
	Results           []PriceRefreshResult `json:"results,omitempty"`
	RestartRequired   bool                 `json:"restartRequired"`
}

// appApplyResultOf converts the host apply result into the wire shape.
func appApplyResultOf(result ApplyConfigResult, restartRequired bool) appApplyResult {
	return appApplyResult{
		Revision: result.Revision, EffectiveRevision: result.EffectiveRevision, Applied: result.Applied,
		Reason: result.Reason, Configured: result.Configured, ModelCount: result.ModelCount,
		EnabledModelCount: result.EnabledModelCount, Results: result.Results, RestartRequired: restartRequired,
	}
}

// appSettingsView is the settings page payload.
type appSettingsView struct {
	Projects              []map[string]any       `json:"projects"`
	Models                []map[string]any       `json:"models"`
	DefaultModel          *string                `json:"defaultModel"`
	Definitions           any                    `json:"definitions"`
	Capabilities          []CapabilityRecord     `json:"capabilities"`
	CapabilityConfig      []CapabilityConfigView `json:"capabilityConfig"`
	AgentCombinations     any                    `json:"agentCombinations"`
	CapabilityRoot        *string                `json:"capabilityRoot"`
	AgentCombinationFile  *string                `json:"agentCombinationFile"`
	AgentCombinationError *string                `json:"agentCombinationError"`
}

// appCatalogView is the catalog page payload.
type appCatalogView struct {
	Definitions           any                `json:"definitions"`
	Capabilities          []CapabilityRecord `json:"capabilities"`
	AgentCombinations     any                `json:"agentCombinations"`
	CapabilityRoot        *string            `json:"capabilityRoot"`
	AgentCombinationFile  *string            `json:"agentCombinationFile"`
	AgentCombinationError *string            `json:"agentCombinationError"`
}

// appRsiUnavailable is the reply of a daemon without the app bridge.
type appRsiUnavailable struct {
	Available      bool    `json:"available"`
	PendingRestart *string `json:"pendingRestart"`
	CanRestart     bool    `json:"canRestart"`
}

// appSecretRequests is the list of secret writes the desktop app must store.
type appSecretRequests struct {
	Requests []SecretPersistRequest `json:"requests"`
}

// appDisabledTools is the answer of the disabled-tool update.
type appDisabledTools struct {
	DisabledTools []string `json:"disabledTools"`
}

// appHealth is the health probe answer.
type appHealth struct {
	OK bool `json:"ok"`
}

// appUsageCredentials is the credential map the console reads.
type appUsageCredentials struct {
	Credentials map[string]string `json:"credentials"`
}

// appEmptyLayout is the layout a graph without a definition reports.
func appEmptyLayout() GraphLayout {
	return GraphLayout{Positions: map[string]LayoutPosition{}, Edges: []LayoutRoutedEdge{}}
}

// registerRoutes registers every route of the console. The paths and methods
// are the ones RULEBOOK §6 lists.
func (app *GraphApp) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", app.serveHome)
	mux.HandleFunc("GET /api/health", app.serveHealth)
	mux.HandleFunc("GET /api/startup", app.serveStartup)
	mux.HandleFunc("GET /api/agent-context", app.serveAgentContext)
	mux.HandleFunc("PUT /api/agent-context/prompts", app.serveAgentContextPrompt)
	mux.HandleFunc("PUT /api/agent-context/prompts/default", app.serveAgentContextDefault)
	mux.HandleFunc("POST /api/agent-context/prompts/default/reset", app.serveAgentContextDefaultReset)
	mux.HandleFunc("POST /api/agent-context/prompts/reset", app.serveAgentContextPromptReset)
	mux.HandleFunc("PUT /api/agent-context/tools", app.serveAgentContextTools)
	if app.options.Usage != nil {
		mux.HandleFunc("GET /api/usage", app.serveUsage)
		mux.HandleFunc("POST /api/usage/refresh", app.serveUsageRefresh)
		mux.HandleFunc("GET /api/usage/credentials", app.serveUsageCredentials)
	}
	mux.HandleFunc("GET /api/model-pricing", app.serveModelPricing)
	mux.HandleFunc("POST /api/providers/login", app.serveProviderLogin)
	mux.HandleFunc("GET /api/providers/login/{id}", app.serveProviderLoginStatus)
	mux.HandleFunc("POST /api/providers/login/{id}/cancel", app.serveProviderLoginCancel)
	mux.HandleFunc("POST /api/providers/disconnect", app.serveProviderDisconnect)
	mux.HandleFunc("GET "+PROVIDER_ROUTES.List, app.serveProviders)
	mux.HandleFunc("POST "+PROVIDER_ROUTES.Probe, app.serveProviderProbe)
	mux.HandleFunc("POST /api/app/secret", app.serveAppSecret)
	mux.HandleFunc("GET /api/app/secret-requests", app.serveAppSecretRequests)
	mux.HandleFunc("GET /api/app/rsi/status", app.serveAppRsiStatus)
	mux.HandleFunc("POST /api/app/rsi/restart-ack", app.serveAppRsiRestartAck)
	mux.HandleFunc("GET /api/limits", app.serveLimits)
	mux.HandleFunc("GET /api/tool-stats", app.serveToolStats)
	mux.HandleFunc("POST /api/tool-stats/clear", app.serveToolStatsClear)
	mux.HandleFunc("GET /api/skill-stats", app.serveSkillStats)
	mux.HandleFunc("POST /api/skills/promote", app.serveSkillPromote)
	if app.options.ConfigStore != nil {
		mux.HandleFunc("GET /api/config", app.serveConfig)
		mux.HandleFunc("POST /api/config", app.serveConfigSave)
		if app.options.AppServices != nil && app.options.AppServices.RefreshPrices != nil {
			mux.HandleFunc("POST /api/pricing/refresh", app.servePricingRefresh)
		}
		if app.options.ConfigTest != nil {
			mux.HandleFunc("POST /api/config/test", app.serveConfigTest)
		}
	}
	mux.HandleFunc("GET /api/settings", app.serveSettings)
	mux.HandleFunc("GET /api/capabilities/config", app.serveCapabilityConfig)
	mux.HandleFunc("GET /api/tasks", app.serveTasks)
	mux.HandleFunc("GET /api/inbox", app.serveInbox)
	mux.HandleFunc("GET /api/projects/{projectId}/entries", app.serveProjectEntries)
	mux.HandleFunc("GET /api/conversations", app.serveConversations)
	mux.HandleFunc("POST /api/conversations", app.serveConversationCreate)
	mux.HandleFunc("GET /api/conversations/{conversationId}", app.serveConversation)
	mux.HandleFunc("GET /api/messages/{messageId}/attachments/{index}", app.serveAttachment)
	mux.HandleFunc("GET /api/conversations/{conversationId}/history", app.serveConversationHistory)
	mux.HandleFunc("GET /api/conversations/{conversationId}/artifacts", app.serveConversationArtifacts)
	mux.HandleFunc("GET /api/conversations/{conversationId}/draft-graph", app.serveDraftGraph)
	mux.HandleFunc("GET /api/conversations/{conversationId}/proposals/{version}", app.serveProposal)
	mux.HandleFunc("POST /api/conversations/{conversationId}/messages", app.serveConversationMessage)
	mux.HandleFunc("POST /api/conversations/{conversationId}/messages/{messageId}/cancel", app.serveConversationMessageCancel)
	mux.HandleFunc("POST /api/conversations/{conversationId}/model", app.serveConversationModel)
	mux.HandleFunc("POST /api/conversations/{conversationId}/compact", app.serveConversationCompact)
	mux.HandleFunc("POST /api/conversations/{conversationId}/archive", app.serveConversationArchive)
	mux.HandleFunc("POST /api/conversations/{conversationId}/unarchive", app.serveConversationUnarchive)
	mux.HandleFunc("POST /api/conversations/{conversationId}/bind", app.serveConversationBind)
	mux.HandleFunc("POST /api/conversations/{conversationId}/confirm", app.serveConversationConfirm)
	mux.HandleFunc("POST /api/conversations/{conversationId}/drafts/archive", app.serveConversationDraftArchive)
	mux.HandleFunc("POST /api/conversations/{conversationId}/drafts/restore", app.serveConversationDraftRestore)
	mux.HandleFunc("POST /api/conversations/{conversationId}/drafts/delete", app.serveConversationDraftDelete)
	mux.HandleFunc("POST /api/conversations/{conversationId}/pause", app.serveConversationPause)
	mux.HandleFunc("POST /api/conversations/{conversationId}/resume", app.serveConversationResume)
	mux.HandleFunc("POST /api/conversations/{conversationId}/steer", app.serveConversationSteer)
	mux.HandleFunc("POST /api/conversations/{conversationId}/interrupt", app.serveConversationInterrupt)
	mux.HandleFunc("GET /api/conversations/{conversationId}/events", app.serveConversationEvents)
	mux.HandleFunc("GET /api/conversations/{conversationId}/events/stream", app.serveConversationStream)
	mux.HandleFunc("POST /api/tasks", app.serveTaskCreate)
	mux.HandleFunc("GET /api/tasks/{taskId}", app.serveTask)
	mux.HandleFunc("POST /api/tasks/{taskId}/say", app.serveTaskSay)
	mux.HandleFunc("POST /api/tasks/{taskId}/accept", app.serveTaskAccept)
	mux.HandleFunc("POST /api/tasks/{taskId}/abandon", app.serveTaskAbandon)
	mux.HandleFunc("POST /api/tasks/{taskId}/pause", app.serveTaskPause)
	mux.HandleFunc("POST /api/tasks/{taskId}/resume", app.serveTaskResume)
	mux.HandleFunc("POST /api/tasks/{taskId}/budget", app.serveTaskBudget)
	mux.HandleFunc("POST /api/tasks/{taskId}/answer", app.serveTaskAnswer)
	mux.HandleFunc("GET /api/tasks/{taskId}/events", app.serveTaskEvents)
	mux.HandleFunc("GET /api/tasks/{taskId}/events/stream", app.serveTaskStream)
	mux.HandleFunc("POST /api/tasks/{taskId}/nodes/{nodeId}/messages", app.serveNodeMessage)
	mux.HandleFunc("GET /api/tasks/{taskId}/nodes/{nodeId}/run", app.serveNodeRun)
	mux.HandleFunc("GET /api/tasks/{taskId}/nodes/{nodeId}/prompt", app.serveNodePrompt)
	mux.HandleFunc("GET /api/tasks/{taskId}/operations", app.serveOperations)
	mux.HandleFunc("POST /api/tasks/{taskId}/graph/control", app.serveGraphControl)
	mux.HandleFunc("GET /api/tasks/{taskId}/graph/modules/{moduleId}", app.serveGraphModule)
	mux.HandleFunc("GET /api/tasks/{taskId}/graph/modules/{moduleId}/values", app.serveGraphModuleValues)
	mux.HandleFunc("GET /api/tasks/{taskId}/graph/modules/{moduleId}/transitions/{transitionId}", app.serveGraphModuleTransition)
	mux.HandleFunc("GET /api/tasks/{taskId}/graph/edges/{edgeId}", app.serveGraphEdge)
	mux.HandleFunc("GET /api/tasks/{taskId}/graph/edges/{edgeId}/deliveries/{deliveryId}", app.serveGraphEdgeDelivery)
	mux.HandleFunc("GET /api/tasks/{taskId}/graph", app.serveGraph)
	mux.HandleFunc("GET /api/tasks/{taskId}/artifacts", app.serveTaskArtifacts)
	mux.HandleFunc("GET /api/projects/{projectId}/artifacts", app.serveProjectArtifacts)
	mux.HandleFunc("GET /api/tasks/{taskId}/artifacts/{artifactId}", app.serveArtifact)
	mux.HandleFunc("GET /api/tasks/{taskId}/artifacts/{artifactId}/{version}/content", app.serveArtifactContent)
	mux.HandleFunc("POST /api/tasks/{taskId}/artifacts/{artifactId}/{version}/retire", app.serveArtifactRetire)
	mux.HandleFunc("POST /api/tasks/{taskId}/artifacts/{artifactId}/{version}/promote", app.serveArtifactPromote)
	mux.HandleFunc("GET /api/catalog", app.serveCatalog)
	mux.HandleFunc("POST /api/catalog/refresh", app.serveCatalogRefresh)
	mux.HandleFunc("GET /api/catalog/pi-extension-updates", app.servePiExtensionUpdates)
	mux.HandleFunc("GET /api/catalog/pi-packages", app.servePiPackages)
	mux.HandleFunc("POST /api/catalog/pi-extensions/{id}/{version}/update", app.servePiExtensionUpdate)
	mux.HandleFunc("POST /api/catalog/combinations", app.serveCombinationSave)
	mux.HandleFunc("POST /api/catalog/combinations/{id}/description", app.serveCombinationDescription)
	mux.HandleFunc("DELETE /api/catalog/combinations/{id}", app.serveCombinationDelete)
	mux.HandleFunc("POST /api/catalog/combinations/{id}/compile", app.serveCombinationCompile)
	mux.HandleFunc("GET /api/catalog/definitions/{definitionId}", app.serveDefinition)
	if app.options.WebDir != "" {
		mux.HandleFunc("GET /assets/{path...}", app.serveAssets)
	}
}

// serveHome reads the console shell on every request and sets the session
// cookie. A rebuilt bundle must never sit behind a stale page.
func (app *GraphApp) serveHome(w http.ResponseWriter, r *http.Request) {
	SetSessionCookie(w.Header(), app.session)
	body := appDefaultPage()
	if app.options.WebDir != "" {
		raw, err := os.ReadFile(filepath.Join(app.options.WebDir, "index.html"))
		if err == nil {
			body = string(raw)
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
}

// appDefaultPage is the placeholder console page.
func appDefaultPage() string {
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Graph</title></head><body><div id=\"root\">Graph</div></body></html>"
}

// serveAssets serves the built console files.
func (app *GraphApp) serveAssets(w http.ResponseWriter, r *http.Request) {
	relative := r.PathValue("path")
	if relative == "" {
		writeJSON(w, http.StatusNotFound, errorJSON{Code: "not_found", Message: "Not found"})
		return
	}
	root := filepath.Clean(app.options.WebDir)
	file := filepath.Clean(filepath.Join(root, "assets", relative))
	if !strings.HasPrefix(file, root+string(os.PathSeparator)) {
		writeJSON(w, http.StatusForbidden, errorJSON{Code: "forbidden", Message: "Asset path escapes the console root"})
		return
	}
	body, err := os.ReadFile(file)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorJSON{Code: "not_found", Message: "Not found"})
		return
	}
	kind := "text/javascript"
	if strings.HasSuffix(relative, ".css") {
		kind = "text/css"
	} else if strings.HasSuffix(relative, ".json") {
		kind = "application/json"
	} else if strings.HasSuffix(relative, ".png") {
		kind = "image/png"
	}
	w.Header().Set("Content-Type", kind)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// serveHealth is the health probe.
func (app *GraphApp) serveHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, appHealth{OK: true})
}

// serveStartup is the boot snapshot the console reads.
func (app *GraphApp) serveStartup(w http.ResponseWriter, r *http.Request) {
	if app.options.StartupInfo != nil {
		writeJSON(w, http.StatusOK, app.options.StartupInfo())
		return
	}
	if app.options.Startup != nil {
		writeJSON(w, http.StatusOK, *app.options.Startup)
		return
	}
	writeJSON(w, http.StatusOK, StartupInfo{Mode: "view", Configured: false, ModelCount: 0, EnabledModelCount: 0})
}

// appAgentContextPreview is the prompt library preview of one conversation.
func (app *GraphApp) appAgentContextPreview(conversationID string) any {
	provider, ok := any(app.runtime).(interface {
		AgentContextPreview(conversationID *string) any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the agent context preview yet")
	}
	var id *string
	if conversationID != "" {
		copied := conversationID
		id = &copied
	}
	return provider.AgentContextPreview(id)
}

// serveAgentContext is the prompt library preview.
func (app *GraphApp) serveAgentContext(w http.ResponseWriter, r *http.Request) {
	conversationID := r.URL.Query().Get("conversationId")
	writeJSON(w, http.StatusOK, app.appAgentContextPreview(conversationID))
}

// serveAgentContextPrompt saves one prompt override.
func (app *GraphApp) serveAgentContextPrompt(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, keyOK := body["key"].(string)
	content, contentOK := body["content"].(string)
	if !keyOK || !contentOK {
		Raise("invalid_input", "key and content are required")
	}
	library.SavePrompt(key, content)
	writeJSON(w, http.StatusOK, library.View(nil))
}

// serveAgentContextDefault saves one built-in default.
func (app *GraphApp) serveAgentContextDefault(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, keyOK := body["key"].(string)
	content, contentOK := body["content"].(string)
	if !keyOK || !contentOK {
		Raise("invalid_input", "key and content are required")
	}
	library.SetPromptDefault(key, content)
	writeJSON(w, http.StatusOK, library.View(nil))
}

// serveAgentContextDefaultReset clears one built-in default.
func (app *GraphApp) serveAgentContextDefaultReset(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, ok := body["key"].(string)
	if !ok {
		Raise("invalid_input", "key is required")
	}
	library.ClearPromptDefault(key)
	writeJSON(w, http.StatusOK, library.View(nil))
}

// serveAgentContextPromptReset drops one prompt override.
func (app *GraphApp) serveAgentContextPromptReset(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	key, ok := body["key"].(string)
	if !ok {
		Raise("invalid_input", "key is required")
	}
	library.ResetPrompt(key)
	writeJSON(w, http.StatusOK, library.View(nil))
}

// serveAgentContextTools replaces the disabled-tool list.
func (app *GraphApp) serveAgentContextTools(w http.ResponseWriter, r *http.Request) {
	library := app.appAgentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	body := appJSONBody(w, r)
	raw, ok := body["disabled"].([]any)
	if !ok {
		Raise("invalid_input", "disabled must be a string array")
	}
	disabled := []string{}
	for _, item := range raw {
		name, isText := item.(string)
		if !isText {
			Raise("invalid_input", "disabled must be a string array")
		}
		disabled = append(disabled, name)
	}
	writeJSON(w, http.StatusOK, appDisabledTools{DisabledTools: library.SetDisabledTools(disabled)})
}

// serveUsage is the cached usage snapshot.
func (app *GraphApp) serveUsage(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, UsageSnapshot{})
		return
	}
	snapshot, err := service.Get(false)
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// serveUsageRefresh forces a new usage snapshot.
func (app *GraphApp) serveUsageRefresh(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, UsageSnapshot{})
		return
	}
	snapshot, err := service.Get(true)
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// serveUsageCredentials is the detected subscription credential map.
func (app *GraphApp) serveUsageCredentials(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, appUsageCredentials{Credentials: map[string]string{}})
		return
	}
	credentials, err := service.Credentials()
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, appUsageCredentials{Credentials: credentials})
}

// serveModelPricing is the local price table.
func (app *GraphApp) serveModelPricing(w http.ResponseWriter, r *http.Request) {
	service := app.appUsageService()
	if service == nil {
		writeJSON(w, http.StatusOK, ModelPricingSnapshot{Source: "~/.cc-switch/model-pricing.json", UpdatedAt: nil, Models: []ModelPrice{}})
		return
	}
	pricing, err := service.Pricing()
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, pricing)
}

// serveProviders is the provider directory.
func (app *GraphApp) serveProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.appProvidersView())
}

// serveProviderProbe probes one unsaved provider draft.
func (app *GraphApp) serveProviderProbe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.appRunProviderProbe(appJSONBody(w, r)))
}

func (app *GraphApp) serveProviderLogin(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.loginService().start(rsiText(body["providerId"]), rsiText(body["credentialRef"])))
}
func (app *GraphApp) serveProviderLoginStatus(w http.ResponseWriter, r *http.Request) {
	service := app.loginService()
	writeJSON(w, http.StatusOK, service.view(service.get(r.PathValue("id"))))
}
func (app *GraphApp) serveProviderLoginCancel(w http.ResponseWriter, r *http.Request) {
	service := app.loginService()
	login := service.get(r.PathValue("id"))
	service.cancel(login)
	writeJSON(w, http.StatusOK, service.view(login))
}
func (app *GraphApp) serveProviderDisconnect(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.loginService().disconnect(rsiText(body["credentialRef"])))
}

// serveAppSecret stores one secret the desktop app pushed.
func (app *GraphApp) serveAppSecret(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil {
		Raise("invalid_config", "The daemon was started without the app bridge")
	}
	body := appJSONBody(w, r)
	ref, ok := body["ref"].(string)
	if !ok {
		Raise("invalid_input", "secretRef is required")
	}
	var value *string
	if raw, present := body["value"]; present && raw != nil {
		text, isText := raw.(string)
		if !isText {
			Raise("invalid_input", "The secret value must be a string or null")
		}
		value = &text
	}
	var persisted *bool
	if flag, isBool := body["persisted"].(bool); isBool {
		persisted = &flag
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.PushSecret(ref, value, persisted))
}

// serveAppSecretRequests lists the secret writes the desktop app must store.
func (app *GraphApp) serveAppSecretRequests(w http.ResponseWriter, r *http.Request) {
	requests := []SecretPersistRequest{}
	if app.options.AppServices != nil {
		requests = app.options.AppServices.PendingSecretRequests()
	}
	writeJSON(w, http.StatusOK, appSecretRequests{Requests: requests})
}

// serveAppRsiStatus is the restart queue of the desktop app.
func (app *GraphApp) serveAppRsiStatus(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.Rsi == nil {
		writeJSON(w, http.StatusOK, appRsiUnavailable{Available: false, PendingRestart: nil, CanRestart: false})
		return
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.Rsi.Status(r.URL.Query().Get("compare") == "1"))
}

// serveAppRsiRestartAck acknowledges one restart request.
func (app *GraphApp) serveAppRsiRestartAck(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.Rsi == nil {
		Raise("invalid_config", "The daemon was started without the app bridge")
	}
	body := appJSONBody(w, r)
	id, ok := body["id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		Raise("invalid_input", "A restart request id is required")
	}
	writeJSON(w, http.StatusOK, app.options.AppServices.Rsi.Ack(strings.TrimSpace(id)))
}

// serveLimits is the model limit table.
func (app *GraphApp) serveLimits(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ModelLimits())
}

// serveToolStats is the recorded tool-call telemetry.
func (app *GraphApp) serveToolStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ToolCallStats())
}

// serveToolStatsClear drops the recorded tool calls.
func (app *GraphApp) serveToolStatsClear(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.ClearToolCalls())
}

// serveSkillStats is the skill telemetry.
func (app *GraphApp) serveSkillStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.SkillStats())
}

// serveSkillPromote promotes one project skill into the capability library.
func (app *GraphApp) serveSkillPromote(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	skillID, ok := body["skillId"].(string)
	if !ok || strings.TrimSpace(skillID) == "" {
		Raise("invalid_input", "skillId is required")
	}
	writeJSON(w, http.StatusOK, app.runtime.PromoteSkill(strings.TrimSpace(skillID)))
}

// serveConfig is the configuration the console edits.
func (app *GraphApp) serveConfig(w http.ResponseWriter, r *http.Request) {
	store := app.appConfigStore()
	if store == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	snapshot := store.Snapshot()
	view := appConfigView{
		Revision:          snapshot.Revision,
		Config:            SanitizeConfig(snapshot.Config, app.appProviderSecrets()),
		PendingSecretRefs: []string{},
		Watch:             nil,
	}
	if app.options.AppServices != nil {
		if status, ok := app.options.AppServices.Snapshot().(ApplyConfigResult); ok {
			revision := status.EffectiveRevision
			configured := status.Configured
			view.EffectiveRevision = &revision
			view.Configured = &configured
		}
		for _, request := range app.options.AppServices.PendingSecretRequests() {
			view.PendingSecretRefs = append(view.PendingSecretRefs, request.Ref)
		}
		if report := app.options.AppServices.ConfigWatch(); report != nil {
			view.Watch = &appConfigWatch{
				Watching: report.Watching, Events: report.Events, Applied: report.Applied,
				Ignored: report.Ignored, LastEventAt: report.LastEventAt, LastReason: report.LastReason,
				FileRevision: report.FileRevision,
			}
		}
	}
	writeJSON(w, http.StatusOK, view)
}

// serveConfigSave stores and activates one configuration document.
func (app *GraphApp) serveConfigSave(w http.ResponseWriter, r *http.Request) {
	store := app.appConfigStore()
	if store == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	body := appJSONBody(w, r)
	expectedRevision, ok := appBodyInt(body, "expectedRevision")
	if !ok || expectedRevision < 0 {
		Raise("invalid_input", "expectedRevision must be a nonnegative integer")
	}
	document := body["document"]
	current := store.Snapshot()
	nextIDs := map[string]bool{}
	if entries, ok := appDocumentModelIDs(document); ok {
		nextIDs = entries
	}
	currentIDs := map[string]bool{}
	if current.Config.Models != nil {
		for _, entry := range current.Config.Models.Entries {
			currentIDs[entry.Id] = true
		}
	}
	removed := []string{}
	for _, id := range app.runtime.ModelsInUse() {
		if currentIDs[id] && !nextIDs[id] {
			removed = append(removed, id)
		}
	}
	if len(removed) > 0 {
		Raise("config_in_use", "Models in use by unfinished tasks cannot be removed: "+strings.Join(removed, ", "))
	}
	if app.options.AppServices != nil {
		// Hot apply: persist through the same atomic store, then activate the
		// candidate on this daemon. A rejected candidate keeps the previous
		// effective bindings and reports why instead of a false success.
		applied, ok := app.options.AppServices.ApplyConfig(document, expectedRevision).(ApplyConfigResult)
		if !ok {
			Raise("internal", "The configuration apply returned no result")
		}
		writeJSON(w, http.StatusOK, appApplyResultOf(applied, false))
		return
	}
	saved := store.Save(document, expectedRevision, app.appConfigEnv(), nil)
	writeJSON(w, http.StatusOK, appConfigSaveResult{
		Revision: saved.Revision, RestartRequired: current.Revision != saved.Revision,
	})
}

// appDocumentModelIDs reads the model ids of a configuration document.
func appDocumentModelIDs(document any) (map[string]bool, bool) {
	record, ok := document.(map[string]any)
	if !ok {
		return map[string]bool{}, false
	}
	models, ok := record["models"].(map[string]any)
	if !ok {
		return map[string]bool{}, false
	}
	entries, ok := models["entries"].([]any)
	if !ok {
		return map[string]bool{}, false
	}
	ids := map[string]bool{}
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id, _ := item["id"].(string)
		ids[id] = true
	}
	return ids, true
}

// servePricingRefresh re-verifies the archived prices.
func (app *GraphApp) servePricingRefresh(w http.ResponseWriter, r *http.Request) {
	if app.options.AppServices == nil || app.options.AppServices.RefreshPrices == nil {
		Raise("invalid_config", "The daemon was started without the app bridge")
	}
	body := appJSONBody(w, r)
	expectedRevision, ok := appBodyInt(body, "expectedRevision")
	if !ok || expectedRevision < 0 {
		Raise("invalid_input", "expectedRevision must be a nonnegative integer")
	}
	refreshed, ok := app.options.AppServices.RefreshPrices(expectedRevision).(ApplyConfigResult)
	if !ok {
		Raise("internal", "The price refresh returned no result")
	}
	writeJSON(w, http.StatusOK, appApplyResultOf(refreshed, false))
}

// serveConfigTest proves that one configured model can be reached.
func (app *GraphApp) serveConfigTest(w http.ResponseWriter, r *http.Request) {
	if app.options.ConfigTest == nil {
		Raise("invalid_config", "The daemon was started without a configuration file")
	}
	body := appJSONBody(w, r)
	modelID, ok := body["modelId"].(string)
	if !ok || strings.TrimSpace(modelID) == "" {
		Raise("invalid_input", "modelId is required")
	}
	writeJSON(w, http.StatusOK, app.options.ConfigTest(strings.TrimSpace(modelID)))
}

// serveSettings is the settings page payload.
func (app *GraphApp) serveSettings(w http.ResponseWriter, r *http.Request) {
	catalog := app.runtime.Catalog()
	// The resource library renders the grouped view: one row per skill name,
	// duplicates folded. The capability configuration reads the same list.
	capabilities := catalog.CapabilitiesView()
	view := appSettingsView{
		Projects:              app.runtime.User().Projects(),
		Models:                app.runtime.Models(),
		DefaultModel:          app.runtime.DefaultModel(),
		Definitions:           appDefinitionSummaries(catalog.ListDefinitions()),
		Capabilities:          capabilities,
		CapabilityConfig:      CapabilityConfigViews(capabilities, app.appCapabilitySecrets()),
		AgentCombinations:     catalog.AgentCombinations(),
		CapabilityRoot:        appOptionalString(catalog.CapabilityRootPath()),
		AgentCombinationFile:  appOptionalString(catalog.AgentCombinationFilePath()),
		AgentCombinationError: catalog.AgentCombinationError(),
	}
	writeJSON(w, http.StatusOK, view)
}

// appCapabilitySecrets is the secret view the capability configuration reads.
func (app *GraphApp) appCapabilitySecrets() map[string]string {
	if app.options.AppServices != nil && app.options.AppServices.CapabilityConfig != nil {
		return app.options.AppServices.CapabilityConfig.SecretValues()
	}
	secrets := map[string]string{}
	for _, entry := range os.Environ() {
		name, secret, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(secret) == "" {
			continue
		}
		secrets[name] = secret
	}
	return secrets
}

// appDefinitionSummary is one published definition of the catalog.
type appDefinitionSummary struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

// appDefinitionSummaries maps the catalog definition list into the wire shape.
func appDefinitionSummaries(definitions []struct {
	Id      string
	Version int64
}) []appDefinitionSummary {
	summaries := make([]appDefinitionSummary, 0, len(definitions))
	for _, definition := range definitions {
		summaries = append(summaries, appDefinitionSummary{ID: definition.Id, Version: definition.Version})
	}
	return summaries
}

// appOptionalString turns an empty path into a null.
func appOptionalString(value string) *string {
	if value == "" {
		return nil
	}
	copied := value
	return &copied
}

// serveCapabilityConfig is the capability configuration view.
func (app *GraphApp) serveCapabilityConfig(w http.ResponseWriter, r *http.Request) {
	items := CapabilityConfigViews(app.runtime.Catalog().Capabilities(), app.appCapabilitySecrets())
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// serveTasks is the task list.
func (app *GraphApp) serveTasks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.User().List())
}

// serveInbox is the operator inbox.
func (app *GraphApp) serveInbox(w http.ResponseWriter, r *http.Request) {
	limit := 0
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": app.runtime.InboxHistory(limit)})
}

// serveProjectEntries is the entry list of one project.
func (app *GraphApp) serveProjectEntries(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("projectId")
	query := r.URL.Query().Get("q")
	limit := 80
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": app.runtime.ProjectEntries(projectID, query, limit)})
}

// serveConversations is the conversation list.
func (app *GraphApp) serveConversations(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Conversations().List(appQueryBool(r, "archived")))
}

// serveConversationCreate starts one conversation.
func (app *GraphApp) serveConversationCreate(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := TaskRuntimeConversationInput{RequestId: appBodyString(body, "requestId")}
	if value, ok := body["projectId"].(string); ok && value != "" {
		input.ProjectId = &value
	}
	if value, ok := body["title"].(string); ok && value != "" {
		input.Title = &value
	}
	if value, ok := body["text"].(string); ok && value != "" {
		input.Text = &value
	}
	if value, ok := body["model"].(string); ok && value != "" {
		input.Model = &value
	}
	if value, ok := body["thinkingLevel"].(string); ok && value != "" {
		input.ThinkingLevel = &value
	}
	if raw, ok := body["attachments"].([]any); ok {
		attachments, err := appAttachments(raw)
		if err != nil {
			panic(err)
		}
		input.Attachments = attachments
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Create(input))
}

// appAttachments reads the attachment list of a request body.
func appAttachments(raw []any) ([]AttachmentInput, error) {
	attachments := []AttachmentInput{}
	for _, item := range raw {
		record, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("attachment must be an object")
		}
		attachment := AttachmentInput{}
		if value, ok := record["name"].(string); ok {
			attachment.Name = value
		}
		if value, ok := record["type"].(string); ok {
			attachment.Type = value
		}
		if value, ok := record["size"].(float64); ok {
			attachment.Size = int64(value)
		}
		if value, ok := record["text"].(string); ok {
			attachment.Text = value
		}
		if value, ok := record["data"].(string); ok {
			attachment.Data = &value
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

// serveConversation is one conversation with its messages.
func (app *GraphApp) serveConversation(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, app.appConversationView(conversationID, r))
}

// appConversationView reads one conversation.
func (app *GraphApp) appConversationView(conversationID string, r *http.Request) any {
	provider, ok := any(app.runtime.Conversations()).(interface {
		View(conversationID string, query NodeEntryQuery) map[string]any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the conversation view yet")
	}
	query := NodeEntryQuery{}
	if value, ok := appQueryNumber(r, "after"); ok {
		query.After = &value
	}
	if value, ok := appQueryNumber(r, "before"); ok {
		query.Before = &value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = &value
	}
	return provider.View(conversationID, query)
}

// serveAttachment serves one inline image attachment.
func (app *GraphApp) serveAttachment(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("messageId")
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		Raise("not_found", "Attachment not found")
	}
	attachment := app.runtime.Conversations().Attachment(messageID, index)
	kind, _ := attachment["type"].(string)
	raw := appAttachmentBytes(attachment["bytes"])
	w.Header().Set("cache-control", "private, max-age=3600")
	w.Header().Set("x-content-type-options", "nosniff")
	w.Header().Set("Content-Type", kind)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// appAttachmentBytes reads the bytes of one inline attachment. The runtime
// hands the base64 payload over; the wire format is the raw image.
func appAttachmentBytes(value any) []byte {
	switch typed := value.(type) {
	case []byte:
		return typed
	case *string:
		if typed == nil {
			return nil
		}
		decoded, err := base64.StdEncoding.DecodeString(*typed)
		if err != nil {
			return []byte(*typed)
		}
		return decoded
	case string:
		decoded, err := base64.StdEncoding.DecodeString(typed)
		if err != nil {
			return []byte(typed)
		}
		return decoded
	}
	return nil
}

// serveConversationHistory is the message history of one conversation.
func (app *GraphApp) serveConversationHistory(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	query := NodeEntryQuery{}
	if value, ok := appQueryNumber(r, "after"); ok {
		query.After = &value
	}
	if value, ok := appQueryNumber(r, "before"); ok {
		query.Before = &value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = &value
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().History(conversationID, query))
}

// serveConversationArtifacts is the artifact list of one conversation.
func (app *GraphApp) serveConversationArtifacts(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, app.runtime.ListConversationArtifacts(conversationID, appArtifactQuery(r)))
}

// appArtifactQuery reads the artifact query parameters.
func appArtifactQuery(r *http.Request) ArtifactQuery {
	query := ArtifactQuery{}
	values := r.URL.Query()
	query.ArtifactId = values.Get("artifactId")
	query.Namespace = values.Get("namespace")
	query.Prefix = values.Get("prefix")
	query.Schema = values.Get("schema")
	query.Tag = values.Get("tag")
	query.Trust = values.Get("trust")
	query.IncludeRetired = values.Get("includeRetired") == "true"
	if values.Get("latestOnly") == "false" {
		latest := false
		query.LatestOnly = &latest
	}
	if value, ok := appQueryInt(r, "limit"); ok {
		query.Limit = &value
	}
	query.Cursor = values.Get("cursor")
	return query
}

// serveDraftGraph is the graph draft of one conversation.
func (app *GraphApp) serveDraftGraph(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	view := app.appConversationView(conversationID, r)
	record, _ := view.(map[string]any)
	proposal, _ := record["proposal"].(map[string]any)
	var spec map[string]any
	if proposal != nil {
		spec, _ = proposal["spec"].(map[string]any)
	}
	if spec == nil {
		writeJSON(w, http.StatusOK, appGraphStructure{Containers: []appGraphContainer{}, Nodes: []appGraphNode{}, Loops: []any{}, Layout: appEmptyLayout()})
		return
	}
	definition, ok := spec["definition"]
	if !ok {
		Raise("invalid_proposal", "A native graph definition is required")
	}
	parsed := ParseGraphDefinition(definition)
	structure := app.appNativeGraphStructure(parsed, nil)
	interfaces := []any{}
	for _, edgeID := range appSortedKeys(parsed.Edges) {
		edge := parsed.Edges[edgeID]
		parts := strings.SplitN(edge.To, ".", 2)
		id := parts[0]
		port := ""
		if len(parts) > 1 {
			port = parts[1]
		}
		protocol := (*string)(nil)
		if target, found := parsed.Nodes[id]; found {
			if reference, ok := target.Inputs[port]; ok {
				value := reference.Protocol
				protocol = &value
			}
		} else if target, found := parsed.Modules[id]; found {
			if reference, ok := target.Inputs[port]; ok {
				value := reference.Protocol
				protocol = &value
			}
		}
		interfaces = append(interfaces, map[string]any{
			"edgeId": edgeID, "from": edge.From, "to": edge.To,
			"protocol": protocol, "latest": nil, "deliveries": []any{},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": structure.Nodes, "containers": structure.Containers, "loops": structure.Loops,
		"layout": structure.Layout, "interfaces": interfaces,
	})
}

// serveProposal is one proposal version of a conversation.
func (app *GraphApp) serveProposal(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil || version < 1 {
		Raise("invalid_input", "version must be a positive integer")
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Proposal(conversationID, version))
}

// serveConversationMessage adds one user message.
func (app *GraphApp) serveConversationMessage(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	input := TaskRuntimeChatInput{
		Text:      appBodyString(body, "text"),
		RequestId: appBodyString(body, "requestId"),
	}
	if raw, ok := body["attachments"].([]any); ok {
		attachments, err := appAttachments(raw)
		if err != nil {
			panic(err)
		}
		input.Attachments = attachments
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Chat(conversationID, input))
}

// serveConversationMessageCancel drops one queued message.
func (app *GraphApp) serveConversationMessageCancel(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	input := TaskRuntimeCancelInput{
		MessageId: r.PathValue("messageId"),
		RequestId: appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().CancelMessage(conversationID, input))
}

// serveConversationModel selects the model of one conversation.
func (app *GraphApp) serveConversationModel(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().SelectModel(
		conversationID, appBodyString(body, "model"), appBodyString(body, "thinkingLevel"), appBodyString(body, "requestId")))
}

// serveConversationCompact compacts the history of one conversation.
func (app *GraphApp) serveConversationCompact(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Compact(conversationID, appBodyString(body, "requestId")))
}

// serveConversationArchive archives one conversation.
func (app *GraphApp) serveConversationArchive(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Archive(conversationID, appBodyString(body, "requestId")))
}

// serveConversationUnarchive restores one archived conversation.
func (app *GraphApp) serveConversationUnarchive(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Unarchive(conversationID, appBodyString(body, "requestId")))
}

// serveConversationBind binds one conversation to a project.
func (app *GraphApp) serveConversationBind(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Bind(
		conversationID, appBodyString(body, "projectId"), appBodyString(body, "requestId")))
}

// serveConversationConfirm confirms the proposal of one conversation.
func (app *GraphApp) serveConversationConfirm(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	draftRevision, _ := appBodyInt(body, "draftRevision")
	input := TaskRuntimeConfirmInput{
		ProposalVersion: proposalVersion,
		DraftRevision:   draftRevision,
		TargetBranch:    appBodyString(body, "targetBranch"),
		RequestId:       appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Confirm(conversationID, input))
}

// serveConversationDraftArchive archives one draft version.
func (app *GraphApp) serveConversationDraftArchive(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().ArchiveDraft(conversationID, TaskRuntimeDraftInput{
		ProposalVersion: proposalVersion, RequestId: appBodyString(body, "requestId"),
	}))
}

// serveConversationDraftRestore restores one archived draft version.
func (app *GraphApp) serveConversationDraftRestore(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().RestoreDraft(conversationID, TaskRuntimeDraftInput{
		ProposalVersion: proposalVersion, RequestId: appBodyString(body, "requestId"),
	}))
}

// serveConversationDraftDelete deletes one draft version.
func (app *GraphApp) serveConversationDraftDelete(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().DeleteDraft(conversationID, TaskRuntimeDraftInput{
		ProposalVersion: proposalVersion, RequestId: appBodyString(body, "requestId"),
	}))
}

// serveConversationPause pauses one conversation.
func (app *GraphApp) serveConversationPause(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Pause(conversationID, appBodyString(body, "requestId")))
}

// serveConversationResume resumes one conversation.
func (app *GraphApp) serveConversationResume(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Resume(conversationID, appBodyString(body, "requestId")))
}

// serveConversationSteer steers one running conversation.
func (app *GraphApp) serveConversationSteer(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	provider, ok := any(app.runtime.Conversations()).(interface {
		Steer(conversationID string, requestID string) map[string]any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the conversation steer yet")
	}
	writeJSON(w, http.StatusOK, provider.Steer(conversationID, appBodyString(body, "requestId")))
}

// serveConversationInterrupt interrupts one running conversation.
func (app *GraphApp) serveConversationInterrupt(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	provider, ok := any(app.runtime.Conversations()).(interface {
		Interrupt(conversationID string, requestID string) map[string]any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the conversation interrupt yet")
	}
	writeJSON(w, http.StatusOK, provider.Interrupt(conversationID, appBodyString(body, "requestId")))
}

// serveConversationEvents is the event page of one conversation.
func (app *GraphApp) serveConversationEvents(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	after := 0
	if value, ok := appQueryInt(r, "after"); ok {
		after = value
	}
	limit := 200
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Events(conversationID, after, limit))
}

// serveConversationStream is the event stream of one conversation.
func (app *GraphApp) serveConversationStream(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	after := appEventCursor(r)
	app.appWriteEventStream(w, r, app.runtime.Conversations().Watch(conversationID, after))
}

// serveTaskCreate starts one task.
func (app *GraphApp) serveTaskCreate(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := TaskRuntimeBeginInput{
		ProjectId: appBodyString(body, "projectId"),
		Request:   appBodyString(body, "request"),
		RequestId: appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.User().Begin(input))
}

// serveTask is one task view.
func (app *GraphApp) serveTask(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.User().Task(r.PathValue("taskId")).View())
}

// serveTaskSay adds one message to a task.
func (app *GraphApp) serveTaskSay(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Say(appBodyString(body, "text"), appBodyString(body, "requestId")))
}

// serveTaskAccept confirms the proposal of a task.
func (app *GraphApp) serveTaskAccept(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	draftRevision, _ := appBodyInt(body, "draftRevision")
	input := TaskRuntimeAcceptInput{
		ProposalVersion: proposalVersion,
		DraftRevision:   draftRevision,
		TargetBranch:    appBodyString(body, "targetBranch"),
		RequestId:       appBodyString(body, "requestId"),
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Accept(input))
}

// serveTaskAbandon abandons one task.
func (app *GraphApp) serveTaskAbandon(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	var reason *string
	if value, ok := body["reason"].(string); ok {
		reason = &value
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Abandon(appBodyString(body, "requestId"), reason))
}

// serveTaskPause pauses one task.
func (app *GraphApp) serveTaskPause(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Pause(appBodyString(body, "requestId")))
}

// serveTaskResume resumes one task.
func (app *GraphApp) serveTaskResume(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Resume(appBodyString(body, "requestId")))
}

// serveTaskBudget changes the budget of one node.
func (app *GraphApp) serveTaskBudget(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := TaskRuntimeBudgetInput{
		NodeId:    appBodyString(body, "nodeId"),
		RequestId: appBodyString(body, "requestId"),
	}
	if raw, present := body["tokens"]; present && raw != nil {
		value, ok := raw.(float64)
		if !ok {
			Raise("invalid_input", "tokens must be a number or null")
		}
		tokens := int64(value)
		input.Tokens = &tokens
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.SetBudget(input))
}

// serveTaskAnswer answers one open question.
func (app *GraphApp) serveTaskAnswer(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	answer := Answer{}
	if raw, ok := body["answer"].(map[string]any); ok {
		if value, ok := raw["type"].(string); ok {
			answer.Type = value
		}
		if value, ok := raw["tokens"].(float64); ok {
			answer.Tokens = int64(value)
		}
		if value, ok := raw["value"]; ok {
			answer.Value = value
		}
		if value, ok := raw["grant"].(string); ok {
			answer.Grant = value
		}
		if value, ok := raw["reason"].(string); ok {
			answer.Reason = &value
		}
		if value, ok := raw["proof"].(string); ok {
			answer.Proof = value
		}
	}
	task := app.runtime.User().Task(r.PathValue("taskId"))
	writeJSON(w, http.StatusOK, task.Answer(appBodyString(body, "questionId"), answer, appBodyString(body, "requestId")))
}

// serveTaskEvents is the event page of one task.
func (app *GraphApp) serveTaskEvents(w http.ResponseWriter, r *http.Request) {
	after := 0
	if value, ok := appQueryInt(r, "after"); ok {
		after = value
	}
	limit := 200
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.Events(r.PathValue("taskId"), after, limit))
}

// serveTaskStream is the event stream of one task.
func (app *GraphApp) serveTaskStream(w http.ResponseWriter, r *http.Request) {
	after := appEventCursor(r)
	task := app.runtime.User().Task(r.PathValue("taskId"))
	app.appWriteEventStream(w, r, task.Watch(after))
}

// appWriteEventStream writes the SSE frames of one watch. The headers are
// flushed before the first event; every event is one `data: <json>\n\n` frame.
func (app *GraphApp) appWriteEventStream(w http.ResponseWriter, r *http.Request, watch TaskWatch) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	if watch.Next == nil {
		return
	}
	// A client disconnect must end the server-side watch, or the daemon
	// shutdown would wait on a stream nobody can consume.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-r.Context().Done():
			if watch.Stop != nil {
				watch.Stop()
			}
		case <-done:
		}
	}()
	for {
		if r.Context().Err() != nil {
			return
		}
		update, ok := watch.Next()
		if !ok {
			return
		}
		raw, err := appJSONBytes(update)
		if err != nil {
			panic(err)
		}
		if _, err := w.Write([]byte("data: ")); err != nil {
			return
		}
		if _, err := w.Write(raw); err != nil {
			return
		}
		if _, err := w.Write([]byte("\n\n")); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}

// appJSONBytes encodes a value the way JSON.stringify does.
func appJSONBytes(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// serveNodeMessage sends one message to a node.
func (app *GraphApp) serveNodeMessage(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := NodeMessageInput{
		Text:      appBodyString(body, "text"),
		RequestID: appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.SendNodeMessage(r.PathValue("taskId"), r.PathValue("nodeId"), input))
}

// serveNodeRun is the transcript of one node.
func (app *GraphApp) serveNodeRun(w http.ResponseWriter, r *http.Request) {
	query := NodeEntryQuery{}
	if value, ok := appQueryNumber(r, "after"); ok {
		query.After = &value
	}
	if value, ok := appQueryNumber(r, "before"); ok {
		query.Before = &value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = &value
	}
	if entry := r.URL.Query().Get("entryId"); entry != "" {
		query.EntryID = &entry
	}
	writeJSON(w, http.StatusOK, app.runtime.NodeRun(r.PathValue("taskId"), r.PathValue("nodeId"), query))
}

// serveNodePrompt is the prompt of one node.
func (app *GraphApp) serveNodePrompt(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.NodePrompt(r.PathValue("taskId"), r.PathValue("nodeId")))
}

// serveOperations is the operation page of one task.
func (app *GraphApp) serveOperations(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()
	query := OperationQuery{Latest: values.Get("latest") == "true"}
	if value := values.Get("after"); value != "" {
		query.After = &value
	}
	if value := values.Get("before"); value != "" {
		query.Before = &value
	}
	if value := values.Get("nodeId"); value != "" {
		query.NodeId = &value
	}
	limit := 50
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	query.Limit = &limit
	writeJSON(w, http.StatusOK, app.runtime.Operations(r.PathValue("taskId"), query))
}

// serveGraphControl applies one graph control action.
func (app *GraphApp) serveGraphControl(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	provider, ok := any(app.runtime).(interface {
		ControlGraph(taskID string, input GraphControlInput) any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the graph control yet")
	}
	input := GraphControlInput{
		Action: appBodyString(body, "action"),
	}
	if value, ok := body["nodeId"].(string); ok {
		input.NodeId = &value
	}
	if value, ok := body["moduleId"].(string); ok {
		input.ModuleId = &value
	}
	if value, ok := appBodyInt(body, "seq"); ok {
		input.Seq = &value
	}
	writeJSON(w, http.StatusOK, provider.ControlGraph(r.PathValue("taskId"), input))
}

// serveGraphModule explains one module of a graph.
func (app *GraphApp) serveGraphModule(w http.ResponseWriter, r *http.Request) {
	query := ModuleHistoryQuery{}
	if value, ok := appQueryNumber(r, "after"); ok {
		query.After = value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.GraphModule(r.PathValue("taskId"), r.PathValue("moduleId"), query))
}

// serveGraphModuleValues explains one module with its full values.
func (app *GraphApp) serveGraphModuleValues(w http.ResponseWriter, r *http.Request) {
	query := ModuleHistoryQuery{FullValues: true, IncludeTransitions: boolPointer(false)}
	writeJSON(w, http.StatusOK, app.runtime.GraphModule(r.PathValue("taskId"), r.PathValue("moduleId"), query))
}

// boolPointer returns a pointer to the value.
func boolPointer(value bool) *bool { return &value }

// serveGraphModuleTransition is one transition of a module.
func (app *GraphApp) serveGraphModuleTransition(w http.ResponseWriter, r *http.Request) {
	transitionID := r.PathValue("transitionId")
	query := ModuleHistoryQuery{TransitionID: &transitionID, Limit: 1}
	explanation := app.runtime.GraphModule(r.PathValue("taskId"), r.PathValue("moduleId"), query)
	writeJSON(w, http.StatusOK, appModuleTransition(explanation, transitionID))
}

// appModuleTransition picks one transition of a module explanation.
func appModuleTransition(explanation ModuleExplanation, transitionID string) any {
	for _, transition := range explanation.Transitions {
		if transition.ID == transitionID {
			return transition
		}
	}
	return nil
}

// serveGraphEdge explains one edge of a graph.
func (app *GraphApp) serveGraphEdge(w http.ResponseWriter, r *http.Request) {
	query := EdgeHistoryQuery{}
	if value, ok := appQueryNumber(r, "before"); ok {
		query.Before = value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.GraphEdge(r.PathValue("taskId"), r.PathValue("edgeId"), query))
}

// serveGraphEdgeDelivery is one delivery of an edge.
func (app *GraphApp) serveGraphEdgeDelivery(w http.ResponseWriter, r *http.Request) {
	deliveryID := r.PathValue("deliveryId")
	query := EdgeHistoryQuery{DeliveryID: &deliveryID, FullValue: true, Limit: 1}
	explanation := app.runtime.GraphEdge(r.PathValue("taskId"), r.PathValue("edgeId"), query)
	writeJSON(w, http.StatusOK, appEdgeDelivery(explanation, deliveryID))
}

// appEdgeDelivery picks one delivery of an edge explanation.
func appEdgeDelivery(explanation EdgeExplanation, deliveryID string) any {
	for _, delivery := range explanation.Deliveries {
		if delivery.ID == deliveryID {
			return delivery
		}
	}
	return nil
}

// serveGraph is the graph view of one task.
func (app *GraphApp) serveGraph(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskId")
	view := app.runtime.User().Task(taskID).View()
	native := app.appKernelGraph(taskID)
	if native == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"nodes": []appGraphNode{}, "containers": []appGraphContainer{}, "loops": []any{},
			"revisions": []any{}, "layout": appEmptyLayout(), "cost": view["cost"],
			"interfaces": []any{}, "modules": []any{}, "messages": []any{},
		})
		return
	}
	structure := app.appNativeGraphStructure(native.Definition, native)
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": structure.Nodes, "containers": structure.Containers, "loops": structure.Loops,
		"layout": structure.Layout, "cost": view["cost"],
		"revisions":  []any{map[string]any{"version": native.Revision, "reason": "graph definition"}},
		"interfaces": native.Edges, "modules": native.Modules,
		"messages": app.runtime.GraphMessages(taskID),
	})
}

// appKernelGraph is the native graph view of one task.
type appKernelGraph struct {
	GraphID      string                `json:"graphId"`
	Definition   GraphDefinition       `json:"definition"`
	Revision     int                   `json:"revision"`
	Edges        []EdgeExplanation     `json:"edges"`
	Modules      []any                 `json:"modules"`
	Nodes        any                   `json:"nodes"`
	States       []appGraphStateNode   `json:"-"`
	StateModules []appGraphStateModule `json:"-"`
}

// appGraphStateNode is the execution state of one graph node.
type appGraphStateNode struct {
	NodeID string `json:"nodeId"`
	Status string `json:"status"`
}

// appGraphStateModule is the execution state of one graph module.
type appGraphStateModule struct {
	ModuleID  string `json:"moduleId"`
	Triggered bool   `json:"triggered"`
}

// appKernelGraphOf reads the native graph view the runtime returns.
func (app *GraphApp) appKernelGraph(taskID string) *appKernelGraph {
	value := app.runtime.KernelGraph(taskID)
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	graph := &appKernelGraph{}
	if err := json.Unmarshal(raw, graph); err != nil {
		panic(err)
	}
	state := struct {
		Nodes   []appGraphStateNode   `json:"nodes"`
		Modules []appGraphStateModule `json:"modules"`
	}{}
	if err := json.Unmarshal(raw, &state); err != nil {
		panic(err)
	}
	graph.States = state.Nodes
	graph.StateModules = state.Modules
	return graph
}

// appGraphNode is one node of the graph structure view.
type appGraphNode struct {
	ID                string                 `json:"id"`
	Kind              string                 `json:"kind"`
	Action            string                 `json:"action"`
	Container         string                 `json:"container,omitempty"`
	Status            string                 `json:"status"`
	BoundDefinition   string                 `json:"boundDefinition,omitempty"`
	DefinitionVersion string                 `json:"definitionVersion,omitempty"`
	Inputs            map[string]ProtocolRef `json:"inputs"`
	Outputs           map[string]ProtocolRef `json:"outputs"`
	Agent             any                    `json:"agent"`
}

// appGraphContainer is one subgraph instance of the graph structure view.
type appGraphContainer struct {
	ID       string                 `json:"id"`
	Parent   string                 `json:"parent,omitempty"`
	Template string                 `json:"template"`
	Version  int                    `json:"version"`
	Inputs   map[string]GraphIo     `json:"inputs"`
	Outputs  map[string]GraphOutput `json:"outputs"`
	Nodes    []string               `json:"nodes"`
}

// appGraphStructure is the graph the console draws.
type appGraphStructure struct {
	Nodes      []appGraphNode      `json:"nodes"`
	Containers []appGraphContainer `json:"containers"`
	Loops      []any               `json:"loops"`
	Layout     GraphLayout         `json:"layout"`
}

// appSortedKeys returns the sorted keys of a map. The TypeScript object kept
// the definition order; the Go map does not.
func appSortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// appNativeGraphStructure is the topology of one graph. Drafts and running
// graphs share topology; execution state never determines layout.
func (app *GraphApp) appNativeGraphStructure(definition GraphDefinition, native *appKernelGraph) appGraphStructure {
	groups := appSortedKeys(definition.SubgraphInstances)
	containerFor := func(id string) string {
		best := ""
		for _, group := range groups {
			if strings.HasPrefix(id, group+"/") && len(group) > len(best) {
				best = group
			}
		}
		return best
	}
	containers := []appGraphContainer{}
	for _, id := range groups {
		binding := definition.SubgraphInstances[id]
		container := appGraphContainer{
			ID: id, Parent: containerFor(id), Template: binding.Template, Version: binding.Version,
			Inputs: binding.Inputs, Outputs: binding.Outputs, Nodes: []string{},
		}
		for _, node := range appSortedKeys(definition.Nodes) {
			if strings.HasPrefix(node, id+"/") {
				container.Nodes = append(container.Nodes, node)
			}
		}
		containers = append(containers, container)
	}
	nodes := []appGraphNode{}
	for _, id := range appSortedKeys(definition.Nodes) {
		node := definition.Nodes[id]
		entry := appGraphNode{
			ID: id, Kind: "agent", Action: node.Task, Container: containerFor(id),
			Status: "draft", BoundDefinition: node.Recipe, DefinitionVersion: node.Recipe,
			Inputs: node.Inputs, Outputs: node.Outputs,
			Agent: app.appGraphAgentDetail(node.Recipe),
		}
		if native != nil {
			entry.Status = "idle"
			for _, state := range native.States {
				if state.NodeID == id {
					entry.Status = state.Status
					break
				}
			}
			if entry.Status == "" {
				entry.Status = "idle"
			}
		}
		nodes = append(nodes, entry)
	}
	for _, id := range appSortedKeys(definition.Modules) {
		module := definition.Modules[id]
		action := "route"
		switch {
		case module.Type == "operation":
			action = "graph.command"
		case module.Type == "command":
			action = "command"
		case module.Trigger == "once":
			action = "join"
		}
		entry := appGraphNode{
			ID: id, Kind: "module", Action: action, Container: containerFor(id),
			Status: "draft", Inputs: module.Inputs, Outputs: module.Outputs,
		}
		if native != nil {
			entry.Status = "idle"
			for _, state := range native.StateModules {
				if state.ModuleID == id {
					if state.Triggered {
						entry.Status = "succeeded"
					}
					break
				}
			}
		}
		nodes = append(nodes, entry)
	}
	edges := []appGraphEdge{}
	for _, id := range appSortedKeys(definition.Edges) {
		edge := definition.Edges[id]
		edges = append(edges, appGraphEdge{
			ID:     id,
			Source: strings.SplitN(edge.From, ".", 2)[0],
			Target: strings.SplitN(edge.To, ".", 2)[0],
		})
	}
	input := LayoutInput{Nodes: []LayoutNode{}, Edges: []LayoutEdge{}, Containers: []LayoutGroup{}}
	for _, node := range nodes {
		action := node.Action
		if node.Kind == "agent" {
			action = "work"
		}
		input.Nodes = append(input.Nodes, LayoutNode{ID: node.ID, Kind: node.Kind, Action: action, Container: node.Container})
	}
	for _, edge := range edges {
		input.Edges = append(input.Edges, LayoutEdge{ID: edge.ID, Source: edge.Source, Target: edge.Target})
	}
	for _, container := range containers {
		input.Containers = append(input.Containers, LayoutGroup{ID: container.ID, Parent: container.Parent})
	}
	layout := app.appGraphLayout(input, native)
	return appGraphStructure{Nodes: nodes, Containers: containers, Loops: []any{}, Layout: layout}
}

// appGraphEdge is one edge of the graph structure view.
type appGraphEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

// appGraphLayout places the graph. The stored layout of the same topology is
// reused; a changed topology is laid out again.
func (app *GraphApp) appGraphLayout(input LayoutInput, native *appKernelGraph) GraphLayout {
	key := CanonicalJSON(input)
	if native == nil {
		return app.appFreshLayout(input, key)
	}
	for {
		state := app.runtime.GraphLayout(native.GraphID, native.Revision)
		epoch := int64(0)
		switch value := state["epoch"].(type) {
		case int64:
			epoch = value
		case int:
			epoch = int64(value)
		case float64:
			epoch = int64(value)
		}
		snapshot, _ := state["snapshot"].(map[string]any)
		if snapshot != nil {
			topology, _ := snapshot["topology"].(string)
			if topology == key {
				return app.appLayoutOf(snapshot["layout"])
			}
			previous := LayoutPrevious{Input: input, Layout: app.appLayoutOf(snapshot["layout"])}
			if stored, err := app.appLayoutInput(topology); err == nil {
				previous.Input = stored
			}
			result := LayoutGraph(input, &previous)
			if app.runtime.SaveGraphLayout(native.GraphID, native.Revision, key, result, epoch) {
				return result
			}
			continue
		}
		result := app.appFreshLayout(input, key)
		if app.runtime.SaveGraphLayout(native.GraphID, native.Revision, key, result, epoch) {
			return result
		}
	}
}

// appFreshLayout places a graph that has no stored layout yet.
func (app *GraphApp) appFreshLayout(input LayoutInput, key string) GraphLayout {
	app.layoutMutex.Lock()
	defer app.layoutMutex.Unlock()
	if layout, ok := app.layouts[key]; ok {
		return layout
	}
	layout := LayoutGraph(input, nil)
	if len(app.layouts) >= 100 && len(app.layoutOrder) > 0 {
		delete(app.layouts, app.layoutOrder[0])
		app.layoutOrder = app.layoutOrder[1:]
	}
	app.layouts[key] = layout
	app.layoutOrder = append(app.layoutOrder, key)
	return layout
}

// appLayoutOf reads a stored layout.
func (app *GraphApp) appLayoutOf(value any) GraphLayout {
	if value == nil {
		return appEmptyLayout()
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	layout := GraphLayout{}
	if err := json.Unmarshal(raw, &layout); err != nil {
		panic(err)
	}
	if layout.Positions == nil {
		layout.Positions = map[string]LayoutPosition{}
	}
	if layout.Edges == nil {
		layout.Edges = []LayoutRoutedEdge{}
	}
	return layout
}

// appLayoutInput reads the stored topology of a layout.
func (app *GraphApp) appLayoutInput(topology string) (LayoutInput, error) {
	input := LayoutInput{}
	if err := json.Unmarshal([]byte(topology), &input); err != nil {
		return LayoutInput{}, err
	}
	return input, nil
}

// appGraphCapability is one capability a bound Agent declares.
type appGraphCapability struct {
	ID      string  `json:"id"`
	Version string  `json:"version"`
	Role    string  `json:"role"`
	Kind    *string `json:"kind"`
	Name    string  `json:"name"`
	Status  string  `json:"status"`
	Source  *string `json:"source"`
}

// appGraphExperience is the recorded experience of one bound Agent.
type appGraphExperience struct {
	Task    any   `json:"task"`
	Samples []any `json:"samples"`
}

// appGraphAgent is the Agent bound to one graph node.
type appGraphAgent struct {
	ID               string               `json:"id"`
	Version          int                  `json:"version"`
	Name             string               `json:"name"`
	Description      string               `json:"description"`
	RecommendedGrade string               `json:"recommendedGrade"`
	Review           bool                 `json:"review"`
	Capabilities     []appGraphCapability `json:"capabilities"`
	Experience       appGraphExperience   `json:"experience"`
}

// appGraphAgentDetail is the Agent bound to one graph node.
func (app *GraphApp) appGraphAgentDetail(definitionVersion string) any {
	if definitionVersion == "" {
		return nil
	}
	index := strings.LastIndex(definitionVersion, "@")
	if index <= 0 {
		return nil
	}
	id := definitionVersion[:index]
	version, err := strconv.Atoi(definitionVersion[index+1:])
	if err != nil || version < 0 {
		return nil
	}
	detail, ok := app.recoverValue(func() any {
		return app.runtime.Catalog().Definition(id + "@" + strconv.Itoa(version))
	})
	if !ok {
		return nil
	}
	definition := detail.(CatalogDefinition)
	provider, ok := any(app.runtime).(interface {
		Talent(id string, version *int, allVersions bool) any
	})
	if !ok {
		return nil
	}
	view, ok := provider.Talent(id, &version, false).(map[string]any)
	if !ok {
		return nil
	}
	talentDetail, _ := view["detail"].(map[string]any)
	experience, _ := view["experience"].(map[string]any)
	if talentDetail == nil {
		return nil
	}
	snapshot, _ := talentDetail["snapshot"].(map[string]any)
	combination, _ := snapshot["agentCombination"].(map[string]any)
	name := id
	if combination != nil {
		if value, ok := combination["name"].(string); ok && value != "" {
			name = value
		}
	}
	description := ""
	if value, ok := talentDetail["description"].(string); ok {
		description = value
	}
	if combination != nil {
		if value, ok := combination["description"].(string); ok && value != "" {
			description = value
		}
	}
	recommendedGrade := ""
	if value, ok := talentDetail["recommendedGrade"].(string); ok {
		recommendedGrade = value
	}
	review := false
	if value, ok := talentDetail["review"].(bool); ok {
		review = value
	}
	samples := []any{}
	if experience != nil {
		if list, ok := experience["samples"].([]any); ok {
			samples = list
		}
	}
	if len(samples) > 5 {
		samples = samples[len(samples)-5:]
	}
	reversed := make([]any, 0, len(samples))
	for index := len(samples) - 1; index >= 0; index-- {
		reversed = append(reversed, samples[index])
	}
	taskSummary := any(nil)
	if experience != nil {
		taskSummary = experience["task"]
	}
	return appGraphAgent{
		ID: id, Version: version, Name: name, Description: description,
		RecommendedGrade: recommendedGrade, Review: review,
		Capabilities: app.appGraphAgentCapabilities(definition),
		Experience:   appGraphExperience{Task: taskSummary, Samples: reversed},
	}
}

// appGraphAgentCapabilities are the capabilities one bound Agent declares.
func (app *GraphApp) appGraphAgentCapabilities(definition CatalogDefinition) []appGraphCapability {
	capabilities := []appGraphCapability{}
	bound := []struct {
		binding CapabilityBinding
		role    string
	}{}
	for _, capability := range definition.Capabilities {
		bound = append(bound, struct {
			binding CapabilityBinding
			role    string
		}{capability, "capability"})
	}
	if definition.Prompts != nil {
		if definition.Prompts.Agent != nil {
			bound = append(bound, struct {
				binding CapabilityBinding
				role    string
			}{*definition.Prompts.Agent, "agent"})
		}
		if definition.Prompts.Tool != nil {
			bound = append(bound, struct {
				binding CapabilityBinding
				role    string
			}{*definition.Prompts.Tool, "tool"})
		}
	}
	for _, item := range bound {
		record := app.runtime.Catalog().Capability(item.binding.Id, item.binding.Version)
		view := appGraphCapability{
			ID: item.binding.Id, Version: item.binding.Version, Role: item.role,
			Kind: nil, Name: item.binding.Id, Status: "missing", Source: nil,
		}
		if record != nil {
			kind := record.Kind
			view.Kind = &kind
			if record.Name != "" {
				view.Name = record.Name
			}
			if record.Status != "" {
				view.Status = record.Status
			}
			source := record.Source
			view.Source = &source
		}
		capabilities = append(capabilities, view)
	}
	return capabilities
}

// serveTaskArtifacts is the artifact list of one task.
func (app *GraphApp) serveTaskArtifacts(w http.ResponseWriter, r *http.Request) {
	query := appArtifactQuery(r)
	query.TaskId = r.PathValue("taskId")
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().List(query))
}

// serveProjectArtifacts is the artifact list of one project.
func (app *GraphApp) serveProjectArtifacts(w http.ResponseWriter, r *http.Request) {
	query := appArtifactQuery(r)
	query.IncludeTaskArtifacts = r.URL.Query().Get("include") == "task"
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().ListProject(r.PathValue("projectId"), query))
}

// serveArtifact is one artifact record.
func (app *GraphApp) serveArtifact(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	if scope != "" && scope != "task" && scope != "project" {
		Raise("invalid_artifact", "scope must be task or project")
	}
	var version *int
	if raw := r.URL.Query().Get("version"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			Raise("invalid_input", "version must be a number")
		}
		version = &value
	}
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().Get(r.PathValue("taskId"), r.PathValue("artifactId"), version, scope))
}

// serveArtifactContent is the content of one artifact version.
func (app *GraphApp) serveArtifactContent(w http.ResponseWriter, r *http.Request) {
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		Raise("invalid_input", "version must be a number")
	}
	scope := r.URL.Query().Get("scope")
	if scope != "task" && scope != "project" {
		scope = ""
	}
	result := app.runtime.Artifacts().Read(r.PathValue("taskId"), r.PathValue("artifactId"), version, 262_144, scope)
	if r.URL.Query().Get("download") == "true" {
		raw, err := os.ReadFile(result.Path)
		if err != nil {
			panic(err)
		}
		w.Header().Set("content-disposition", "attachment; filename=\""+result.Record.Name+"\"")
		w.Header().Set("Content-Type", result.Record.MediaType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifact": result.Record, "text": result.Text, "truncated": result.Truncated,
		"bytes": result.Bytes, "events": result.Events,
	})
}

// serveArtifactRetire retires one artifact version.
func (app *GraphApp) serveArtifactRetire(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	reason, reasonOK := body["reason"].(string)
	requestID, requestOK := body["requestId"].(string)
	if !reasonOK || !requestOK {
		Raise("invalid_input", "reason and requestId are required")
	}
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		Raise("invalid_input", "version must be a number")
	}
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().Retire(
		r.PathValue("taskId"), r.PathValue("artifactId"), version, reason, requestID, nil))
}

// serveArtifactPromote promotes one artifact version.
func (app *GraphApp) serveArtifactPromote(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	requestID, ok := body["requestId"].(string)
	if !ok {
		Raise("invalid_input", "requestId is required")
	}
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		Raise("invalid_input", "version must be a number")
	}
	writeJSON(w, http.StatusOK, app.runtime.Artifacts().Promote(ArtifactPromoteInput{
		TaskId: r.PathValue("taskId"), ArtifactId: r.PathValue("artifactId"),
		Version: version, RequestId: requestID,
	}))
}

// serveCatalog is the catalog page payload.
func (app *GraphApp) serveCatalog(w http.ResponseWriter, r *http.Request) {
	catalog := app.runtime.Catalog()
	writeJSON(w, http.StatusOK, appCatalogView{
		Definitions:           appDefinitionSummaries(catalog.ListDefinitions()),
		Capabilities:          catalog.Capabilities(),
		AgentCombinations:     catalog.AgentCombinations(),
		CapabilityRoot:        appOptionalString(catalog.CapabilityRootPath()),
		AgentCombinationFile:  appOptionalString(catalog.AgentCombinationFilePath()),
		AgentCombinationError: catalog.AgentCombinationError(),
	})
}

// serveCatalogRefresh rescans the capability library.
func (app *GraphApp) serveCatalogRefresh(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().Refresh())
}

// servePiExtensionUpdates lists the Pi extensions with a newer version.
func (app *GraphApp) servePiExtensionUpdates(w http.ResponseWriter, r *http.Request) {
	provider, ok := any(app.runtime).(interface{ PiExtensionUpdates() any })
	if !ok {
		Raise("internal", "The task runtime does not expose the Pi extension updates yet")
	}
	writeJSON(w, http.StatusOK, provider.PiExtensionUpdates())
}

// servePiPackages browses the official Pi package channel.
func (app *GraphApp) servePiPackages(w http.ResponseWriter, r *http.Request) {
	input := struct {
		Query string
		Limit int
	}{}
	if query := strings.TrimSpace(r.URL.Query().Get("q")); query != "" {
		input.Query = query
	}
	if limit, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
		input.Limit = limit
	}
	writeJSON(w, http.StatusOK, map[string]any{"packages": SearchPiPackages(input)})
}

// servePiExtensionUpdate installs or upgrades one Pi extension.
func (app *GraphApp) servePiExtensionUpdate(w http.ResponseWriter, r *http.Request) {
	provider, ok := any(app.runtime).(interface {
		UpdatePiExtension(id string, version string) any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the Pi extension update yet")
	}
	writeJSON(w, http.StatusOK, provider.UpdatePiExtension(r.PathValue("id"), r.PathValue("version")))
}

// serveCombinationSave stores one agent combination.
func (app *GraphApp) serveCombinationSave(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	raw, ok := body["combination"]
	if !ok || raw == nil {
		Raise("invalid_input", "combination is required")
	}
	combination, err := appAgentCombination(raw)
	if err != nil {
		panic(err)
	}
	writeJSON(w, http.StatusOK, app.runtime.Catalog().SaveAgentCombination(combination))
}

// appAgentCombination reads one agent combination document.
func appAgentCombination(value any) (AgentCombination, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return AgentCombination{}, err
	}
	combination := AgentCombination{}
	if err := json.Unmarshal(raw, &combination); err != nil {
		return AgentCombination{}, err
	}
	return combination, nil
}

// serveCombinationDescription renames one agent combination.
func (app *GraphApp) serveCombinationDescription(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	description, ok := body["description"].(string)
	if !ok {
		Raise("invalid_input", "description is required")
	}
	writeJSON(w, http.StatusOK, app.runtime.Catalog().UpdateAgentCombinationDescription(r.PathValue("id"), description))
}

// serveCombinationDelete removes one agent combination.
func (app *GraphApp) serveCombinationDelete(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().DeleteAgentCombination(r.PathValue("id")))
}

// serveCombinationCompile compiles one agent combination.
func (app *GraphApp) serveCombinationCompile(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Catalog().CompileAgentCombination(r.PathValue("id")))
}

// serveDefinition is the talent view of one definition.
func (app *GraphApp) serveDefinition(w http.ResponseWriter, r *http.Request) {
	provider, ok := any(app.runtime).(interface {
		Talent(id string, version *int, allVersions bool) any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the talent view yet")
	}
	var version *int
	if raw := r.URL.Query().Get("version"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			Raise("invalid_input", "version must be a number")
		}
		version = &value
	}
	writeJSON(w, http.StatusOK, provider.Talent(r.PathValue("definitionId"), version, r.URL.Query().Get("scope") == "all"))
}
