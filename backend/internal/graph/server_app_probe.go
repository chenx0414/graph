package graph

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

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
		status, payload := app.probeWithRefresh(&target, func(t ProbeTarget) HttpRequestSpec { return BuildModelsRequest(t) },
			func(t ProbeTarget, status int, payload any) bool {
				return xaiCredentialRejected(status, ParseModelsResponse(t, status, payload).Error)
			})
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
		status, payload := app.probeWithRefresh(&target, func(t ProbeTarget) HttpRequestSpec { return BuildVerifyRequest(t, verifyModel) },
			func(t ProbeTarget, status int, payload any) bool {
				return xaiCredentialRejected(status, ParseVerifyResponse(status, payload).Error)
			})
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

// probeWithRefresh answers "does this credential work" instead of "did it work a
// minute ago".
//
// The probe is where a person checks a credential, so a token the vendor just
// rejected is renewed and the same request is sent once more. Only a credential that
// carries a refresh bundle is renewed: a plain API key has nothing to renew, and its
// rejection is the honest answer.
func (app *GraphApp) probeWithRefresh(target *ProbeTarget, build func(ProbeTarget) HttpRequestSpec, rejected func(ProbeTarget, int, any) bool) (int, any) {
	status, payload := appProbeHttp(build(*target))
	if !rejected(*target, status, payload) {
		return status, payload
	}
	ref, ok := app.xaiRefreshableRef(*target)
	if !ok {
		return status, payload
	}
	if err := app.loginService().xaiRefreshNow(context.Background(), ref); err != nil {
		return status, payload
	}
	fresh := strings.TrimSpace(app.appProviderSecrets()[ref])
	if fresh == "" {
		return status, payload
	}
	key := fresh
	target.APIKey = &key
	return appProbeHttp(build(*target))
}

// xaiRefreshableRef names the credential a probe used, when that credential also has
// a refresh bundle beside it.
func (app *GraphApp) xaiRefreshableRef(target ProbeTarget) (string, bool) {
	if target.APIKey == nil {
		return "", false
	}
	key := strings.TrimSpace(*target.APIKey)
	secrets := app.appProviderSecrets()
	service := app.loginService()
	for ref, value := range secrets {
		if strings.HasSuffix(ref, xaiRefreshSuffix) || strings.TrimSpace(value) != key {
			continue
		}
		if service.hasXaiBundle(ref) {
			return ref, true
		}
	}
	return "", false
}
