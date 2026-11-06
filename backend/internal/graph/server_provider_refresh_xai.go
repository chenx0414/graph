package graph

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// A rejected OAuth credential is not a verdict about the work: the access token
// ran out, or the server dropped it. Until this file existed the only refresh was a
// timer (watchXai), so a token the vendor rejected early was never renewed: the
// probe answered "The OAuth2 access token could not be validated", reviews died on
// 401, and the timer gave up after three attempts without telling anybody.
//
// This file adds the missing half: a refresh the caller can ask for *because* a
// request was rejected, one outcome for the whole daemon, a loud state when the
// vendor refuses the refresh itself, and a write-ahead order so a rotated refresh
// token is on disk before the access token it belongs to is used.

// xaiCredentialRejected reports whether a vendor answer means "this access token is
// no longer accepted".
//
// xAI answers 401 with "The OAuth2 access token could not be validated"; a gateway in
// front of it can answer 403 with the same wording, and some proxies only pass the
// status. Both are the same fact, so both are matched here instead of at each caller.
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

// credentialRejection reports whether a failed turn failed because its credential was
// rejected (as opposed to the work being wrong).
func credentialRejection(output string) bool {
	return xaiCredentialRejected(0, output) || providerAuthRejection.MatchString(output)
}

// providerAuthRejection is how a failed turn says the request was not authorized. The
// status alone is enough here: whether the credential can be renewed is decided by the
// refresh itself, which refuses a plain API key.
var providerAuthRejection = regexp.MustCompile(`(?i)Provider answered HTTP (401|403)`)

// xaiRefreshState is what the console is told about one credential.
type xaiRefreshState struct {
	// NeedsRelogin is set when the vendor refused the refresh token itself: no
	// amount of retrying brings that credential back, only a new login does.
	NeedsRelogin bool
	Reason       string
	RefreshedAt  time.Time
}

// xaiRefreshNow renews one credential because a request was rejected.
//
// The order is the point: the rotated refresh token is written and acknowledged
// *before* the access token is used. A crash between the two used to leave the store
// with the new access token and the old refresh token - the one the vendor had
// already consumed - so the next daemon could never refresh again.
func (service *providerLogins) xaiRefreshNow(ctx context.Context, ref string) error {
	bundleRef := ref + xaiRefreshSuffix
	service.refreshMutex.Lock()
	defer service.refreshMutex.Unlock()
	secrets := service.secrets()
	raw := strings.TrimSpace(secrets[bundleRef])
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
		// A refused refresh is the vendor saying this credential is finished. Say
		// so, once, in the same breath as the failed request instead of leaving a
		// silent 401 for the next turn to trip over.
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
	// Write-ahead: the rotated refresh token first. If the host refuses this write,
	// keep using the credential we already have rather than spending a token the
	// store will not remember.
	encoded, encodeErr := json.Marshal(next)
	if encodeErr != nil {
		return fmt.Errorf("刷新凭据无法编码：%w", encodeErr)
	}
	text := string(encoded)
	if !xaiSecretApplied(service.services.PushSecret(bundleRef, &text, nil)) {
		return errors.New("刷新凭据未能写入本机安全存储，未更换访问令牌")
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

// markXaiRelogin records that this credential cannot be renewed, and asks the person
// once. The question is the part that matters: a credential that dies silently is
// discovered by a failed review an hour later.
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

// xaiRefreshStatus reports what the console should show for one credential.
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

// CredentialQuestion is the problem a dead credential files with the person.
//
// It is a question, not a log line: the account can only be fixed by logging in
// again, and that is the one action this daemon cannot take on its own.
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

// credentialQuestion files the dead-credential problem with the person.
//
// It rides on the global conversation's master node, which is the one turn that can
// answer it, and it refuses to file a second copy while one is open: a credential
// that is rejected on every request would otherwise bury the chat in identical cards.
func (app *GraphApp) credentialQuestion(input QuestionInput) {
	if app.runtime == nil || app.runtime.store == nil {
		return
	}
	store := app.runtime.store
	row := credentialQuestionTarget(store)
	if row == nil {
		// Nothing has opened the global thread yet. The person can only act on this
		// problem from a conversation, so the thread that owns it is opened here
		// rather than dropping the question on the floor.
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

// credentialQuestionTarget is the global conversation's master node: the one turn that
// can answer a credential problem.
func credentialQuestionTarget(store *TaskStore) map[string]any {
	return kernelRow(store.Db, `SELECT c.anchor_task_id AS taskId, n.id AS nodeId
    FROM conversations c
    JOIN nodes n ON n.task_id=c.anchor_task_id AND json_extract(n.spec,'$.role')='master'
    WHERE c.role='global' AND c.archived_at IS NULL LIMIT 1`)
}
