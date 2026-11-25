package graph

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func xaiCredentialRejected(status int, message string) bool {
	trimmed := strings.TrimSpace(message)
	if status == 401 {
		return true
	}
	if status == 403 && strings.Contains(strings.ToLower(trimmed), "token") {
		return true
	}
	lowered := strings.ToLower(trimmed)
	return strings.Contains(lowered, "access token could not be validated") ||
		strings.Contains(lowered, "token is expired") ||
		strings.Contains(lowered, "invalid_token")
}

func credentialRejection(output string) bool {
	return xaiCredentialRejected(0, output) || providerAuthRejection.MatchString(output)
}

var providerAuthRejection = regexp.MustCompile(`(?i)Provider answered HTTP (401|403)`)

type xaiRefreshState struct {
	NeedsRelogin bool
	Reason       string
	RefreshedAt  time.Time
}

func (service *providerLogins) xaiRefreshNow(ctx context.Context, ref string) error {
	bundleRef := ref + xaiRefreshSuffix
	service.refreshMutex.Lock()
	defer service.refreshMutex.Unlock()
	raw := strings.TrimSpace(service.xaiBundleText(bundleRef))
	if raw == "" {
		err := errors.New("没有可用的刷新凭据，需要重新登录")
		service.markXaiRelogin(ref, err.Error())
		return err
	}
	var bundle xaiRefreshBundle
	if err := json.Unmarshal([]byte(raw), &bundle); err != nil || bundle.RefreshToken == "" {
		err := errors.New("刷新凭据已损坏，需要重新登录")
		service.markXaiRelogin(ref, err.Error())
		return err
	}
	if !xaiEndpointTrusted(bundle.TokenEndpoint) {
		err := errors.New("刷新端点不受信任，需要重新登录")
		service.markXaiRelogin(ref, err.Error())
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	tokens, err := xaiRefreshAccessToken(callCtx, bundle.TokenEndpoint, bundle.RefreshToken)
	cancel()
	if err != nil {
		reason := "刷新被服务商拒绝：" + err.Error()
		if oauthErr, ok := err.(*xaiOAuthError); ok && oauthErr.code == "invalid_grant" {
			reason = "刷新凭据已失效（invalid_grant），需要重新登录"
		}
		service.markXaiRelogin(ref, reason)
		return errors.New(reason)
	}
	next := xaiRefreshBundle{RefreshToken: bundle.RefreshToken, TokenEndpoint: bundle.TokenEndpoint, AccessExpiresAt: time.Time{}}
	if tokens.RefreshToken != "" {
		next.RefreshToken = tokens.RefreshToken
	}
	if tokens.ExpiresIn > 0 {
		next.AccessExpiresAt = time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second)
	}
	if err := service.persistXaiBundle(bundleRef, next); err != nil {
		return err
	}
	access := tokens.AccessToken
	if !xaiSecretApplied(service.services.PushSecret(ref, &access, nil)) {
		return errors.New("访问令牌未能写入本机安全存储")
	}
	service.mutex.Lock()
	if service.relogin != nil {
		delete(service.relogin, ref)
	}
	if service.refreshed == nil {
		service.refreshed = map[string]time.Time{}
	}
	service.refreshed[ref] = time.Now()
	service.mutex.Unlock()
	return nil
}

func (service *providerLogins) markXaiRelogin(ref, reason string) {
	service.mutex.Lock()
	if service.relogin == nil {
		service.relogin = map[string]string{}
	}
	previous := service.relogin[ref]
	service.relogin[ref] = reason
	service.mutex.Unlock()
	if previous == reason {
		return
	}
	if service.ask == nil {
		return
	}
	service.ask(CredentialQuestion(ref, reason))
}

func (service *providerLogins) xaiRefreshStatus(ref string) (xaiRefreshState, bool) {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	reason, needs := service.relogin[ref]
	refreshed := service.refreshed[ref]
	if !needs && refreshed.IsZero() {
		return xaiRefreshState{}, false
	}
	return xaiRefreshState{NeedsRelogin: needs, Reason: reason, RefreshedAt: refreshed}, true
}

func CredentialQuestion(ref, reason string) QuestionInput {
	return QuestionInput{
		Kind: "credential",
		Data: map[string]any{
			"credentialRef": ref,
			"reason":        reason,
			"ask":           "Grok 凭据已失效，无法自动刷新。请在 设置 → 模型 里重新登录 Grok（设备码）；登录完成后回复我，我继续原来的工作。",
		},
	}
}

func (app *GraphApp) credentialQuestion(input QuestionInput) {
	if app.runtime == nil || app.runtime.store == nil {
		return
	}
	store := app.runtime.store
	row := credentialQuestionTarget(store)
	if row == nil {
		app.runtime.EnsureGlobalThread("credential:recovery")
		row = credentialQuestionTarget(store)
	}
	if row == nil {
		return
	}
	taskId := kernelString(row["taskId"])
	nodeId := kernelString(row["nodeId"])
	if taskId == "" || nodeId == "" {
		return
	}
	open := kernelRow(store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND kind=? AND status='open'",
		taskId, nodeId, input.Kind)
	if open != nil {
		return
	}
	input.TaskId = taskId
	input.NodeId = nodeId
	InsertQuestion(store, input)
}

func credentialQuestionTarget(store *TaskStore) map[string]any {
	return kernelRow(store.Db, `SELECT c.anchor_task_id AS taskId, n.id AS nodeId
    FROM conversations c
    JOIN nodes n ON n.task_id=c.anchor_task_id AND json_extract(n.spec,'$.role')='master'
    WHERE c.role='global' AND c.archived_at IS NULL LIMIT 1`)
}

func (service *providerLogins) xaiBundleText(ref string) string {
	if text := strings.TrimSpace(service.readXaiBundle(ref)); text != "" {
		return text
	}
	return strings.TrimSpace(service.secrets()[ref])
}

func (service *providerLogins) hasXaiBundle(ref string) bool {
	return strings.TrimSpace(service.xaiBundleText(ref+xaiRefreshSuffix)) != ""
}

func (service *providerLogins) xaiBundlePath(ref string) string {
	if service.stateDir == "" {
		return ""
	}
	return filepath.Join(service.stateDir, "xai-refresh-"+ref+".json")
}

func (service *providerLogins) writeXaiBundle(ref, text string) error {
	path := service.xaiBundlePath(ref)
	if path == "" {
		return nil
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, []byte(text), 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	return nil
}

func (service *providerLogins) readXaiBundle(ref string) string {
	path := service.xaiBundlePath(ref)
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}

func (service *providerLogins) persistXaiBundle(bundleRef string, bundle xaiRefreshBundle) error {
	encoded, err := json.Marshal(bundle)
	if err != nil {
		return fmt.Errorf("刷新凭据无法编码：%w", err)
	}
	text := string(encoded)
	if writeErr := service.writeXaiBundle(bundleRef, text); writeErr != nil {
		return fmt.Errorf("刷新凭据未能落盘：%w", writeErr)
	}
	xaiSecretApplied(service.services.PushSecret(bundleRef, &text, nil))
	return nil
}

func (service *providerLogins) forgetXaiRelogin(ref string) {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	if service.relogin != nil {
		delete(service.relogin, ref)
	}
}

func (service *providerLogins) dropXaiBundle(bundleRef string) {
	path := service.xaiBundlePath(bundleRef)
	if path == "" {
		return
	}
	_ = os.Remove(path)
}
