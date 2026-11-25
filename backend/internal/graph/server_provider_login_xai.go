package graph

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

const (
	xaiIssuer        = "https://auth.x.ai"
	xaiClientID      = "b1a00492-073a-47ea-816f-4c329264a828"
	xaiScope         = "openid profile email offline_access grok-cli:access api:access"
	xaiUserAgent     = "graph-xai-oauth"
	xaiRefreshSuffix = "_REFRESH"
	xaiRefreshLead   = 5 * time.Minute
)

type xaiDeviceLogin struct {
	userCode        string
	verificationURI string
	completeURI     string
	deviceCode      string
	tokenEndpoint   string
	refreshRef      string
	refreshToken    string
	interval        time.Duration
	expiresAt       time.Time
	accessExpiresAt time.Time
}

type xaiRefreshBundle struct {
	RefreshToken    string    `json:"refreshToken"`
	TokenEndpoint   string    `json:"tokenEndpoint"`
	AccessExpiresAt time.Time `json:"accessExpiresAt"`
}

type xaiEndpoints struct {
	device string
	token  string
}

type xaiDeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type xaiTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

type xaiOAuthError struct {
	code        string
	description string
}

func (failure *xaiOAuthError) Error() string {
	if failure.description != "" {
		return failure.code + ": " + failure.description
	}
	return failure.code
}

func xaiEndpointTrusted(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	base, err := url.Parse(xaiIssuer)
	if err != nil {
		return false
	}
	return parsed.Host == base.Host
}

func xaiDiscovery(ctx context.Context) (xaiEndpoints, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, xaiIssuer+"/.well-known/openid-configuration", nil)
	if err != nil {
		return xaiEndpoints{}, err
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("user-agent", xaiUserAgent)
	response, err := HTTPClient.Do(request)
	if err != nil {
		return xaiEndpoints{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return xaiEndpoints{}, fmt.Errorf("发现文档返回 HTTP %d", response.StatusCode)
	}
	var document struct {
		TokenEndpoint               string `json:"token_endpoint"`
		DeviceAuthorizationEndpoint string `json:"device_authorization_endpoint"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&document); err != nil {
		return xaiEndpoints{}, err
	}
	if !xaiEndpointTrusted(document.TokenEndpoint) || !xaiEndpointTrusted(document.DeviceAuthorizationEndpoint) {
		return xaiEndpoints{}, errors.New("发现文档里的端点不在 x.ai 授权主机上")
	}
	return xaiEndpoints{device: document.DeviceAuthorizationEndpoint, token: document.TokenEndpoint}, nil
}

func xaiPostForm(ctx context.Context, endpoint string, form url.Values, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	request.Header.Set("accept", "application/json")
	request.Header.Set("user-agent", xaiUserAgent)
	response, err := HTTPClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var refused struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		_ = json.Unmarshal(body, &refused)
		if refused.Error == "" {
			refused.Error = fmt.Sprintf("oauth_http_%d", response.StatusCode)
		}
		return &xaiOAuthError{code: refused.Error, description: refused.Description}
	}
	return json.Unmarshal(body, target)
}

func xaiRequestDeviceCode(ctx context.Context, endpoint string) (xaiDeviceCode, error) {
	form := url.Values{"client_id": {xaiClientID}, "scope": {xaiScope}}
	var device xaiDeviceCode
	if err := xaiPostForm(ctx, endpoint, form, &device); err != nil {
		return xaiDeviceCode{}, err
	}
	if device.DeviceCode == "" || device.UserCode == "" || device.VerificationURI == "" {
		return xaiDeviceCode{}, errors.New("授权服务没有返回设备码")
	}
	return device, nil
}

func xaiExchangeDeviceCode(ctx context.Context, endpoint, deviceCode string) (xaiTokens, error) {
	form := url.Values{
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"client_id":   {xaiClientID},
		"device_code": {deviceCode},
	}
	var tokens xaiTokens
	if err := xaiPostForm(ctx, endpoint, form, &tokens); err != nil {
		return xaiTokens{}, err
	}
	if tokens.AccessToken == "" {
		return xaiTokens{}, errors.New("令牌响应缺少 access_token")
	}
	return tokens, nil
}

func xaiRefreshAccessToken(ctx context.Context, endpoint, refreshToken string) (xaiTokens, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {xaiClientID},
		"refresh_token": {refreshToken},
	}
	var tokens xaiTokens
	if err := xaiPostForm(ctx, endpoint, form, &tokens); err != nil {
		return xaiTokens{}, err
	}
	if tokens.AccessToken == "" {
		return xaiTokens{}, errors.New("刷新响应缺少 access_token")
	}
	return tokens, nil
}

func xaiSecretApplied(result any) bool {
	encoded, err := json.Marshal(result)
	if err != nil {
		return false
	}
	var applied struct {
		Applied bool `json:"applied"`
	}
	_ = json.Unmarshal(encoded, &applied)
	return applied.Applied
}

func (service *providerLogins) startXai(ref string) map[string]any {
	if !providerSecretRef.MatchString(ref) {
		Raise("invalid_input", "凭据引用无效")
	}
	service.mutex.Lock()
	defer service.mutex.Unlock()
	if service.disconnecting[ref] {
		Raise("invalid_input", "正在断开此凭据，请稍后重试")
	}
	for id, login := range service.values {
		view := service.view(login)
		state := view["state"]
		if login.ref == ref && (state == "starting" || state == "waiting" || state == "saving") {
			return view
		}
		if len(service.values) >= 16 && (state == "complete" || state == "failed" || state == "cancelled") {
			delete(service.values, id)
		}
	}
	if len(service.values) >= 16 {
		Raise("invalid_input", "登录流程过多，请先取消已有流程")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	login := &providerLogin{
		id: graphUUID(), provider: "xai", ref: ref, state: "starting",
		cancel: cancel, done: make(chan struct{}),
		xai: &xaiDeviceLogin{refreshRef: ref + xaiRefreshSuffix, interval: 5 * time.Second},
	}
	service.values[login.id] = login
	go func() {
		defer close(login.done)
		service.runXai(ctx, login)
	}()
	return service.view(login)
}

func (service *providerLogins) runXai(ctx context.Context, login *providerLogin) {
	defer func() {
		login.mutex.Lock()
		if login.state == "starting" || login.state == "waiting" {
			login.state = "cancelled"
		}
		login.mutex.Unlock()
	}()
	endpoints, err := xaiDiscovery(ctx)
	if err != nil {
		if ctx.Err() == nil {
			service.failXai(login, "无法连接 xAI 授权服务："+err.Error())
		}
		return
	}
	device, err := xaiRequestDeviceCode(ctx, endpoints.device)
	if err != nil {
		if ctx.Err() == nil {
			service.failXai(login, "申请设备码失败："+err.Error())
		}
		return
	}
	interval := time.Duration(device.Interval) * time.Second
	if interval < 2*time.Second {
		interval = 2 * time.Second
	}
	if interval > 60*time.Second {
		interval = 60 * time.Second
	}
	lifetime := time.Duration(device.ExpiresIn) * time.Second
	if lifetime <= 0 {
		lifetime = 30 * time.Minute
	}
	address := device.VerificationURIComplete
	if address == "" {
		address = device.VerificationURI
	}
	login.mutex.Lock()
	if login.state != "starting" {
		login.mutex.Unlock()
		return
	}
	login.state = "waiting"
	login.address = address
	login.xai.userCode = device.UserCode
	login.xai.verificationURI = device.VerificationURI
	login.xai.completeURI = device.VerificationURIComplete
	login.xai.deviceCode = device.DeviceCode
	login.xai.tokenEndpoint = endpoints.token
	login.xai.interval = interval
	login.xai.expiresAt = time.Now().Add(lifetime)
	login.mutex.Unlock()
	service.pollXai(ctx, login)
}

func (service *providerLogins) pollXai(ctx context.Context, login *providerLogin) {
	wait := login.xai.interval + 3*time.Second
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		tokens, err := xaiExchangeDeviceCode(ctx, login.xai.tokenEndpoint, login.xai.deviceCode)
		if err != nil {
			var refused *xaiOAuthError
			if errors.As(err, &refused) {
				switch refused.code {
				case "authorization_pending":
					continue
				case "slow_down":
					wait += 5 * time.Second
					continue
				case "access_denied":
					service.failXai(login, "你在 xAI 授权页拒绝了这次登录。")
					return
				case "expired_token":
					service.failXai(login, "登录码已过期，请重新生成。")
					return
				}
			}
			if ctx.Err() != nil {
				return
			}
			service.failXai(login, "换取 xAI 访问令牌失败："+err.Error())
			return
		}
		if ctx.Err() != nil {
			return
		}
		service.completeXai(login, tokens)
		return
	}
}

func (service *providerLogins) completeXai(login *providerLogin, tokens xaiTokens) {
	login.mutex.Lock()
	login.state = "saving"
	ref := login.ref
	refreshRef := login.xai.refreshRef
	tokenEndpoint := login.xai.tokenEndpoint
	login.mutex.Unlock()
	accessExpiresAt := time.Time{}
	if tokens.ExpiresIn > 0 {
		accessExpiresAt = time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second)
	}
	access := tokens.AccessToken
	if !xaiSecretApplied(service.services.PushSecret(ref, &access, nil)) {
		service.failXai(login, "授权已通过，但访问令牌未能写入本机安全存储。")
		return
	}
	if tokens.RefreshToken != "" {
		bundle := xaiRefreshBundle{RefreshToken: tokens.RefreshToken, TokenEndpoint: tokenEndpoint, AccessExpiresAt: accessExpiresAt}
		if persistErr := service.persistXaiBundle(refreshRef, bundle); persistErr == nil {
			login.mutex.Lock()
			login.xai.refreshToken = tokens.RefreshToken
			login.mutex.Unlock()
			service.forgetXaiRelogin(ref)
		}
	}
	login.mutex.Lock()
	login.state = "complete"
	login.xai.accessExpiresAt = accessExpiresAt
	refreshToken := login.xai.refreshToken
	login.mutex.Unlock()
	if refreshToken != "" {
		go service.watchXai(login)
	}
}

func (service *providerLogins) failXai(login *providerLogin, message string) {
	login.mutex.Lock()
	login.state = "failed"
	login.failure = message
	login.mutex.Unlock()
	if login.cancel != nil {
		login.cancel()
	}
}

func (service *providerLogins) watchXai(login *providerLogin) {
	failures := 0
	for {
		login.mutex.Lock()
		expiresAt := login.xai.accessExpiresAt
		refreshToken := login.xai.refreshToken
		tokenEndpoint := login.xai.tokenEndpoint
		ref := login.ref
		refreshRef := login.xai.refreshRef
		login.mutex.Unlock()
		refreshAt := time.Now().Add(45 * time.Minute)
		if !expiresAt.IsZero() {
			refreshAt = expiresAt.Add(-xaiRefreshLead)
		}
		wait := time.Until(refreshAt)
		if wait < time.Second {
			wait = time.Second
		}
		select {
		case <-service.background.Done():
			return
		case <-time.After(wait):
		}
		ctx, cancel := context.WithTimeout(service.background, 30*time.Second)
		tokens, err := xaiRefreshAccessToken(ctx, tokenEndpoint, refreshToken)
		cancel()
		if err != nil {
			failures++
			if failures >= 3 || service.background.Err() != nil {
				return
			}
			continue
		}
		failures = 0
		access := tokens.AccessToken
		if !xaiSecretApplied(service.services.PushSecret(ref, &access, nil)) {
			continue
		}
		nextRefresh := tokens.RefreshToken
		if nextRefresh == "" {
			nextRefresh = refreshToken
		}
		expires := time.Now().Add(45 * time.Minute)
		if tokens.ExpiresIn > 0 {
			expires = time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second)
		}
		bundle := xaiRefreshBundle{RefreshToken: nextRefresh, TokenEndpoint: tokenEndpoint, AccessExpiresAt: expires}
		_ = service.persistXaiBundle(refreshRef, bundle)
		service.forgetXaiRelogin(ref)
		login.mutex.Lock()
		login.xai.refreshToken = nextRefresh
		login.xai.accessExpiresAt = expires
		login.mutex.Unlock()
	}
}

func (service *providerLogins) resumeXai() {
	if service.secrets == nil || service.background == nil {
		return
	}
	refs := map[string]bool{}
	for ref := range service.secrets() {
		if strings.HasSuffix(ref, xaiRefreshSuffix) {
			refs[ref] = true
		}
	}
	for _, ref := range xaiBundleRefs(service.stateDir) {
		refs[ref] = true
	}
	for ref := range refs {
		value := service.xaiBundleText(ref)
		if value == "" {
			continue
		}
		var bundle xaiRefreshBundle
		if json.Unmarshal([]byte(value), &bundle) != nil || bundle.RefreshToken == "" {
			continue
		}
		if !xaiEndpointTrusted(bundle.TokenEndpoint) {
			continue
		}
		login := &providerLogin{
			id: graphUUID(), provider: "xai", ref: strings.TrimSuffix(ref, xaiRefreshSuffix), state: "complete",
			xai: &xaiDeviceLogin{
				refreshRef: ref, refreshToken: bundle.RefreshToken,
				tokenEndpoint: bundle.TokenEndpoint, accessExpiresAt: bundle.AccessExpiresAt,
			},
		}
		go service.watchXai(login)
	}
}

func xaiBundleRefs(stateDir string) []string {
	if stateDir == "" {
		return nil
	}
	matches, err := filepath.Glob(filepath.Join(stateDir, "xai-refresh-*.json"))
	if err != nil {
		return nil
	}
	refs := make([]string, 0, len(matches))
	for _, path := range matches {
		name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "xai-refresh-"), ".json")
		if name != "" {
			refs = append(refs, name)
		}
	}
	return refs
}
