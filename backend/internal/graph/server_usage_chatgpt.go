package graph

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"strconv"
	"strings"
)

func usageDecodeJwtPayload(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	part := parts[1]
	if part == "" {
		return nil
	}
	padding := (4 - len(part)%4) % 4
	decoded, err := base64.RawURLEncoding.DecodeString(part + strings.Repeat("=", padding))
	if err != nil {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(decoded, &parsed); err != nil {
		return nil
	}
	return usageRecord(parsed)
}

func usageJwtAccountId(token string) *string {
	payload := usageDecodeJwtPayload(token)
	auth := usageRecord(payload["https://api.openai.com/auth"])
	organizations := []map[string]any{}
	for _, value := range usageArray(payload["organizations"]) {
		if record := usageRecord(value); record != nil {
			organizations = append(organizations, record)
		}
	}
	if value := usageText(payload["chatgpt_account_id"]); value != nil {
		return value
	}
	if value := usageText(auth["chatgpt_account_id"]); value != nil {
		return value
	}
	if len(organizations) > 0 {
		return usageText(organizations[0]["id"])
	}
	return nil
}

func usageChatGptCredential(home string, env map[string]string) (*usageCredential, error) {
	envToken := usageSelectedCredential(env, UsageProviderChatGPT, []string{"GRAPH_CHATGPT_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN"}, usageDefaultBaseURLs[UsageProviderChatGPT])
	if envToken != nil {
		envToken.AccountID = usageText(env["GRAPH_CHATGPT_ACCOUNT_ID"])
		return envToken, nil
	}
	path := strings.TrimSpace(env["GRAPH_CODEX_AUTH_PATH"])
	if path == "" {
		path = filepath.Join(home, ".codex", "auth.json")
	}
	raw, err := readUsageJSONSafe(path)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	root := usageRecord(raw)
	tokens := usageRecord(root["tokens"])
	accessToken := usageText(tokens["access_token"])
	if root == nil || accessToken == nil {
		return nil, errors.New("Codex auth.json 缺少 tokens.access_token")
	}
	accountID := usageText(tokens["account_id"])
	if accountID == nil {
		accountID = usageJwtAccountId(*accessToken)
	}
	return &usageCredential{
		ID: string(UsageProviderChatGPT), SecretRef: usageSubscriptionSecretRefs[UsageProviderChatGPT],
		Configured: true, Value: *accessToken, AccountID: accountID,
		Source: "Codex CLI 登录", BaseURL: usageDefaultBaseURLs[UsageProviderChatGPT],
	}, nil
}

func usageChatGptLabel(seconds *float64) string {
	if seconds == nil {
		return "用量窗口"
	}
	if *seconds <= 6*3600 {
		return "5 小时"
	}
	if *seconds <= 8*86400 {
		return "本周"
	}
	if *seconds <= 32*86400 {
		return "本月"
	}
	days := int(math.Round(*seconds / 86400))
	if days < 1 {
		days = 1
	}
	return strconv.Itoa(days) + " 天"
}

func usageCodexWindows(body map[string]any) []UsageWindow {
	windows := []UsageWindow{}
	appendWindows := func(rateLimit any, prefix string) {
		limit := usageRecord(rateLimit)
		if limit == nil {
			return
		}
		for index, key := range []string{"primary_window", "secondary_window"} {
			raw := usageRecord(limit[key])
			if raw == nil {
				continue
			}
			percent := number(raw["used_percent"])
			if percent == nil {
				continue
			}
			seconds := number(raw["limit_window_seconds"])
			windows = append(windows, usagePercentWindow(prefix+"-"+strconv.Itoa(index), usageChatGptLabel(seconds), *percent, parseDate(raw["reset_at"]), usageWindowDetails{}))
		}
	}
	appendWindows(body["rate_limit"], "codex")
	for index, raw := range usageArray(body["additional_rate_limits"]) {
		item := usageRecord(raw)
		appendWindows(item["rate_limit"], "additional-"+strconv.Itoa(index))
	}
	return windows
}

func usageFetchChatGpt(credential *usageCredential, prices []ModelPrice) (UsagePlan, error) {
	headers := map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
		"user-agent": "codex-cli",
	}
	if credential.AccountID != nil {
		headers["chatgpt-account-id"] = *credential.AccountID
	}
	status, _, raw, err := usageFetch("GET", usageChatGPTURL, headers, nil, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	if status == 401 || status == 403 {
		return UsagePlan{}, errors.New("ChatGPT 登录凭据已过期，请重新登录 Codex")
	}
	body, err := usageResponseJSON(status, raw, "ChatGPT 用量")
	if err != nil {
		return UsagePlan{}, err
	}
	windows := usageCodexWindows(body)
	if len(windows) == 0 {
		return UsagePlan{}, errors.New("用量响应中没有可识别的配额窗口")
	}
	credits := usageRecord(body["credits"])
	creditBalance := number(credits["balance"])
	models := usageDiscoverChatGptModels(credential, prices)
	plan := usageBasePlan(UsageProviderChatGPT, true, usageStatusFor(windows))
	planName := "ChatGPT"
	if value := usageText(body["plan_type"]); value != nil {
		planName = *value
	}
	plan.Plan = providerStringPointer(planName)
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Models = models
	plan.Windows = windows
	if creditBalance != nil {
		plan.Balance = &UsageBalance{Remaining: creditBalance, Currency: providerStringPointer("USD"), Unit: providerStringPointer("$")}
	}
	return plan, nil
}
