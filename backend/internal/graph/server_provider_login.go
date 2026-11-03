package graph

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"bytes"
)

// Browser authorization is owned by the host. Neither codes nor keys enter a
// renderer response; the existing desktop secret channel persists the result.
// Two flows share this record: the OpenRouter PKCE browser callback and the xAI
// device-code login. `xai` is set only for the latter.
type providerLogin struct {
	id, provider, ref, state, address, verifier, path string
	failure                                           string
	cancel                                            context.CancelFunc
	done                                              chan struct{}
	server                                            *http.Server
	claimed                                           bool
	xai                                               *xaiDeviceLogin
	mutex                                             sync.Mutex
}

type providerLogins struct {
	mutex         sync.Mutex
	values        map[string]*providerLogin
	disconnecting map[string]bool
	services      *AppServices
	// secrets reads the values the host already holds. The xAI refresh loop
	// needs the companion refresh secret after a daemon restart.
	secrets    func() map[string]string
	background context.Context
	stop       context.CancelFunc
	startOnce  sync.Once
}

var providerSecretRef = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func (app *GraphApp) loginService() *providerLogins {
	if app.options.AppServices == nil || app.options.AppServices.PushSecret == nil {
		Raise("invalid_config", "浏览器授权需要桌面安全存储通道")
	}
	app.mutex.Lock()
	if app.logins == nil {
		background, stop := context.WithCancel(context.Background())
		service := &providerLogins{
			values: map[string]*providerLogin{}, disconnecting: map[string]bool{},
			services: app.options.AppServices, secrets: app.appProviderSecrets,
			background: background, stop: stop,
		}
		app.logins = service
	}
	service := app.logins
	app.mutex.Unlock()
	// Resuming the xAI refresh loop reads the host secrets, so it must happen
	// outside app.mutex.
	service.startOnce.Do(func() { service.resumeXai() })
	return service
}

func (service *providerLogins) pending(ref string) bool {
	if service.services.PendingSecretRequests != nil {
		for _, request := range service.services.PendingSecretRequests() {
			if request.Ref == ref {
				return true
			}
		}
	}
	return false
}

func (service *providerLogins) view(login *providerLogin) map[string]any {
	login.mutex.Lock()
	defer login.mutex.Unlock()
	state := login.state
	if state == "complete" && service.pending(login.ref) {
		state = "saving"
	}
	provider := login.provider
	if provider == "" {
		provider = "openrouter"
	}
	view := map[string]any{"id": login.id, "providerId": provider, "credentialRef": login.ref, "state": state}
	if state == "waiting" {
		view["url"] = login.address
		if login.xai != nil {
			view["userCode"] = login.xai.userCode
			view["verificationUri"] = login.xai.verificationURI
			view["expiresAt"] = login.xai.expiresAt.Unix()
		}
	}
	if state == "failed" {
		message := login.failure
		if message == "" {
			message = "授权未完成，请重试；若已在服务商创建密钥，可在其账户中撤销。"
		}
		view["message"] = message
	}
	return view
}

func (service *providerLogins) get(id string) *providerLogin {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	login := service.values[id]
	if login == nil {
		Raise("invalid_input", "登录流程不存在或已过期")
	}
	return login
}

func (service *providerLogins) start(provider, ref string) map[string]any {
	switch provider {
	case "xai", "grok":
		return service.startXai(ref)
	case "openrouter", "":
		return service.startOpenRouter(ref)
	}
	Raise("invalid_input", "该服务商尚未启用账号授权")
	return nil
}

func (service *providerLogins) startOpenRouter(ref string) map[string]any {
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
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		Raise("invalid_config", "无法创建本地授权回调")
	}
	random := make([]byte, 32)
	if _, err = rand.Read(random); err != nil {
		_ = listener.Close()
		panic(err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(random)
	challenge := sha256.Sum256([]byte(verifier))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	login := &providerLogin{id: graphUUID(), provider: "openrouter", ref: ref, state: "waiting", verifier: verifier, path: "/oauth/callback/" + graphUUID(), cancel: cancel, done: make(chan struct{})}
	callback := "http://" + listener.Addr().String() + login.path
	login.address = "https://openrouter.ai/auth?" + url.Values{"callback_url": {callback}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}.Encode()
	login.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != login.path {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		login.mutex.Lock()
		if login.claimed || login.state != "waiting" {
			login.mutex.Unlock()
			w.WriteHeader(http.StatusConflict)
			return
		}
		login.claimed = true
		login.mutex.Unlock()
		defer func() { go func() { _ = login.server.Close() }() }()
		if r.URL.Query().Get("error") != "" || r.URL.Query().Get("code") == "" {
			login.mutex.Lock()
			login.state = "failed"
			login.mutex.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			cancel()
			return
		}
		exchangeCtx, stop := context.WithTimeout(ctx, 30*time.Second)
		defer stop()
		payload, _ := json.Marshal(map[string]string{"code": r.URL.Query().Get("code"), "code_verifier": login.verifier, "code_challenge_method": "S256"})
		request, err := http.NewRequestWithContext(exchangeCtx, http.MethodPost, "https://openrouter.ai/api/v1/auth/keys", bytes.NewReader(payload))
		if err == nil {
			request.Header.Set("content-type", "application/json")
			request.Header.Set("accept", "application/json")
		}
		key := ""
		if err == nil {
			var response *http.Response
			response, err = HTTPClient.Do(request)
			if err == nil {
				defer response.Body.Close()
				var result struct {
					Key string `json:"key"`
				}
				if response.StatusCode >= 200 && response.StatusCode < 300 {
					err = json.NewDecoder(http.MaxBytesReader(w, response.Body, 1024*1024)).Decode(&result)
					key = result.Key
				} else {
					err = fmt.Errorf("authorization exchange refused")
				}
			}
		}
		login.mutex.Lock()
		if ctx.Err() != nil {
			login.state = "cancelled"
			login.mutex.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if err != nil || key == "" {
			login.state = "failed"
			login.mutex.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			cancel()
			return
		}
		login.state = "saving"
		login.mutex.Unlock()
		result := service.services.PushSecret(ref, &key, nil)
		encoded, _ := json.Marshal(result)
		var applied struct {
			Applied bool `json:"applied"`
		}
		_ = json.Unmarshal(encoded, &applied)
		login.mutex.Lock()
		if applied.Applied {
			login.state = "complete"
		} else {
			login.state = "failed"
		}
		login.mutex.Unlock()
		if !applied.Applied {
			w.WriteHeader(http.StatusBadRequest)
		} else {
			w.Header().Set("content-type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("授权已完成，可以关闭此页面。"))
		}
		cancel()
	})}
	service.values[login.id] = login
	go func() { _ = login.server.Serve(listener); close(login.done) }()
	go func() {
		<-ctx.Done()
		login.mutex.Lock()
		saving := login.state == "saving"
		if login.state == "waiting" || login.state == "starting" {
			login.state = "cancelled"
		}
		login.mutex.Unlock()
		if !saving {
			_ = login.server.Close()
		}
	}()
	return service.view(login)
}

func (service *providerLogins) cancel(login *providerLogin) {
	login.mutex.Lock()
	saving := login.state == "saving"
	if login.state == "waiting" || login.state == "starting" {
		login.state = "cancelled"
	}
	login.mutex.Unlock()
	if !saving {
		login.cancel()
		// A device-code login has no callback listener; only the PKCE flow owns
		// an HTTP server here.
		if login.server != nil {
			_ = login.server.Close()
		}
	}
	<-login.done
}

func (service *providerLogins) disconnect(ref string) map[string]any {
	if !providerSecretRef.MatchString(ref) {
		Raise("invalid_input", "凭据引用无效")
	}
	service.mutex.Lock()
	if service.disconnecting[ref] {
		service.mutex.Unlock()
		Raise("invalid_input", "正在断开此凭据，请稍后重试")
	}
	service.disconnecting[ref] = true
	logins := []*providerLogin{}
	for _, login := range service.values {
		if login.ref == ref {
			logins = append(logins, login)
		}
	}
	service.mutex.Unlock()
	defer func() { service.mutex.Lock(); delete(service.disconnecting, ref); service.mutex.Unlock() }()
	for _, login := range logins {
		service.cancel(login)
	}
	// The xAI device login keeps a companion refresh secret, and leaving it
	// behind would let a disconnected account come back after the next restart.
	if service.secrets != nil {
		if _, stored := service.secrets()[ref+xaiRefreshSuffix]; stored || service.pending(ref+xaiRefreshSuffix) {
			_ = service.services.PushSecret(ref+xaiRefreshSuffix, nil, nil)
		}
	}
	result := service.services.PushSecret(ref, nil, nil)
	encoded, _ := json.Marshal(result)
	var applied struct {
		Applied bool `json:"applied"`
	}
	_ = json.Unmarshal(encoded, &applied)
	if !applied.Applied {
		Raise("invalid_config", "撤销未能持久化，连接仍然保留，请重试")
	}
	service.mutex.Lock()
	for _, login := range logins {
		delete(service.values, login.id)
	}
	service.mutex.Unlock()
	return map[string]any{"disconnected": true, "persistencePending": service.pending(ref)}
}

func (service *providerLogins) close() {
	if service.stop != nil {
		service.stop()
	}
	service.mutex.Lock()
	logins := []*providerLogin{}
	for _, login := range service.values {
		logins = append(logins, login)
	}
	service.mutex.Unlock()
	for _, login := range logins {
		service.cancel(login)
	}
}
