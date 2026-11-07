package graph

import (
	"errors"
	"strings"
)

func usagePercentWindow(id string, label string, used float64, resetAt *int64, details usageWindowDetails) UsageWindow {
	normalized := clampPercent(used)
	return UsageWindow{
		ID: id, Label: label, UsedPercent: normalized,
		RemainingPercent: clampPercent(100 - normalized), ResetAt: resetAt,
		Used: details.Used, Limit: details.Limit, Unit: details.Unit,
	}
}

func usageOpenCodeWindows(body map[string]any, now int64) []UsageWindow {
	usage := usageRecord(body["usage"])
	if usage == nil {
		return []UsageWindow{}
	}
	windows := []UsageWindow{}
	entries := []struct {
		id    string
		label string
	}{{"rolling", "5 小时"}, {"weekly", "本周"}, {"monthly", "本月"}}
	for _, entry := range entries {
		raw := usageRecord(usage[entry.id])
		if raw == nil {
			continue
		}
		percent := number(raw["percent"])
		if percent == nil {
			continue
		}
		var resetAt *int64
		if *percent > 0 {
			resetAt = parseDate(raw["resetsAt"])
		}
		windows = append(windows, usagePercentWindow(entry.id, entry.label, *percent, resetAt, usageWindowDetails{}))
	}
	if len(windows) == 0 {
		legacy := []struct {
			key   string
			id    string
			label string
		}{{"rollingUsage", "rolling", "5 小时"}, {"weeklyUsage", "weekly", "本周"}, {"monthlyUsage", "monthly", "本月"}}
		for _, entry := range legacy {
			raw := usageRecord(usage[entry.key])
			if raw == nil {
				continue
			}
			percent := number(raw["usagePercent"])
			if percent == nil {
				continue
			}
			resetSeconds := number(raw["resetInSec"])
			var resetAt *int64
			if resetSeconds != nil {
				millis := now + int64(*resetSeconds*1000)
				resetAt = &millis
			}
			windows = append(windows, usagePercentWindow(entry.id, entry.label, *percent, resetAt, usageWindowDetails{}))
		}
	}
	return windows
}

func usageOpenCodeCredential(config *GraphConfig, env map[string]string, openCodeConfig any) *usageCredential {
	return usageFirstCredential(
		usageSelectedCredential(env, UsageProviderOpenCodeGo, []string{"OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"}, usageDefaultBaseURLs[UsageProviderOpenCodeGo]),
		usageConfigCredential(config, env, UsageProviderOpenCodeGo, func(entry ConfiguredModel) bool {
			return strings.Contains(entry.BaseUrl, "opencode.ai/zen/go") || strings.Contains(strings.ToLower(entry.Provider), "opencode-go")
		}),
		usageOpenCodeProviderCredential(openCodeConfig, UsageProviderOpenCodeGo, []string{"opencode-go"}, "opencode.ai/zen/go"),
	)
}

func usageFetchOpenCode(credential *usageCredential, now int64, prices []ModelPrice, openCodeConfig any) (UsagePlan, error) {
	status, _, raw, err := usageFetch("GET", usageOpenCodeURL, map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
	}, nil, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	if status == 403 {
		return UsagePlan{}, errors.New("API Key 有效，但当前账号没有 OpenCode Go 订阅")
	}
	body, err := usageResponseJSON(status, raw, "OpenCode Go 用量")
	if err != nil {
		return UsagePlan{}, err
	}
	windows := usageOpenCodeWindows(body, now)
	if len(windows) == 0 {
		return UsagePlan{}, errors.New("用量响应中没有可识别的配额窗口")
	}
	models := usageDiscoverOpenCodeModels(credential, prices, openCodeConfig)
	plan := usageBasePlan(UsageProviderOpenCodeGo, true, usageStatusFor(windows))
	plan.Plan = providerStringPointer("Go")
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Windows = windows
	plan.Models = models
	return plan, nil
}

func usageCommandWindow(id string, label string, raw map[string]any) *UsageWindow {
	if raw == nil {
		return nil
	}
	used := number(raw["used"])
	limit := number(raw["cap"])
	if used == nil || limit == nil || *limit <= 0 {
		return nil
	}
	reset := number(raw["resetAt"])
	var resetAt *int64
	if reset != nil {
		value := int64(*reset)
		resetAt = &value
	}
	unit := "USD"
	window := usagePercentWindow(id, label, (*used / *limit)*100, resetAt, usageWindowDetails{
		Used: used, Limit: limit, Unit: &unit,
	})
	return &window
}

func usageCommandGoatCredential(config *GraphConfig, env map[string]string, openCodeConfig any) *usageCredential {
	return usageFirstCredential(
		usageSelectedCredential(env, UsageProviderCommandGoat, []string{"COMMANDCODE_API_KEY", "COMMAND_GOAT_API_KEY", "COMMANDCODE_GO_API_KEY"}, usageDefaultBaseURLs[UsageProviderCommandGoat]),
		usageConfigCredential(config, env, UsageProviderCommandGoat, func(entry ConfiguredModel) bool {
			return strings.Contains(entry.BaseUrl, "api.commandcode.ai") || strings.Contains(strings.ToLower(entry.Provider), "command")
		}),
		usageOpenCodeProviderCredential(openCodeConfig, UsageProviderCommandGoat, []string{"command-goat", "commandcode"}, "api.commandcode.ai"),
	)
}

func usageFetchCommandGoat(credential *usageCredential, now int64, prices []ModelPrice, openCodeConfig any) (UsagePlan, error) {
	headers := map[string]string{"authorization": "Bearer " + credential.Value, "accept": "application/json"}
	creditsURL := usageCommandCodeBase + "/alpha/billing/credits"
	subscriptionURL := usageCommandCodeBase + "/alpha/billing/subscriptions"
	type fetchResult struct {
		status int
		raw    []byte
		err    error
	}
	creditsChannel := make(chan fetchResult, 1)
	subscriptionChannel := make(chan fetchResult, 1)
	go func() {
		status, _, raw, err := usageFetch("GET", creditsURL, headers, nil, usageRequestTimeoutMs)
		creditsChannel <- fetchResult{status: status, raw: raw, err: err}
	}()
	go func() {
		status, _, raw, err := usageFetch("GET", subscriptionURL, headers, nil, usageRequestTimeoutMs)
		subscriptionChannel <- fetchResult{status: status, raw: raw, err: err}
	}()
	creditsResult := <-creditsChannel
	subscriptionResult := <-subscriptionChannel
	if creditsResult.err != nil {
		return UsagePlan{}, creditsResult.err
	}
	creditsBody, err := usageResponseJSON(creditsResult.status, creditsResult.raw, "Command Goat 余额")
	if err != nil {
		return UsagePlan{}, err
	}
	credits := usageRecord(creditsBody["credits"])
	if credits == nil {
		return UsagePlan{}, errors.New("余额响应缺少 credits")
	}
	var subscriptionBody map[string]any
	if subscriptionResult.err == nil && subscriptionResult.status >= 200 && subscriptionResult.status < 300 {
		parsed, parseErr := usageResponseJSON(subscriptionResult.status, subscriptionResult.raw, "Command Goat 订阅")
		if parseErr == nil {
			subscriptionBody = parsed
		}
	}
	subscription := usageRecord(subscriptionBody["data"])
	planID := usageText(subscription["planId"])
	monthlyRemaining := 0.0
	if value := number(credits["monthlyCredits"]); value != nil {
		monthlyRemaining = *value
	}
	var monthlyTotal *float64
	if planID != nil {
		if quota, ok := usageCommandPlanQuota[strings.ToLower(*planID)]; ok {
			total := quota
			monthlyTotal = &total
		}
	}
	var monthlyUsed *float64
	if monthlyTotal != nil {
		used := usageMonthlyUsed(*monthlyTotal, monthlyRemaining)
		monthlyUsed = &used
	}
	limits := usageRecord(creditsBody["windowLimits"])
	limited := false
	if value := boolean(limits["limited"]); value != nil {
		limited = *value
	}
	windows := []UsageWindow{}
	if limited {
		if window := usageCommandWindow("five_hour", "5 小时", usageRecord(limits["fiveHour"])); window != nil {
			windows = append(windows, *window)
		}
		if window := usageCommandWindow("weekly", "本周", usageRecord(limits["weekly"])); window != nil {
			windows = append(windows, *window)
		}
		if monthlyTotal != nil && monthlyUsed != nil {
			windows = append(windows, usagePercentWindow("monthly", "本月", (*monthlyUsed / *monthlyTotal)*100,
				parseDate(subscription["currentPeriodEnd"]),
				usageWindowDetails{Used: monthlyUsed, Limit: monthlyTotal, Unit: providerStringPointer("USD")}))
		}
	} else if monthlyTotal != nil && monthlyUsed != nil {
		windows = append(windows, usagePercentWindow("monthly", "本月", (*monthlyUsed / *monthlyTotal)*100,
			parseDate(subscription["currentPeriodEnd"]),
			usageWindowDetails{Used: monthlyUsed, Limit: monthlyTotal, Unit: providerStringPointer("USD")}))
	}
	discovered := usageDiscoverOpenAiCompatible(UsageProviderCommandGoat, credential, prices)
	configuredKeys := usageOpenCodeConfiguredModelKeys(openCodeConfig, []string{"command-goat", "commandcode"})
	models := discovered
	if len(models) == 0 {
		baseURL := credential.BaseURL
		if baseURL == "" {
			baseURL = usageDefaultBaseURLs[UsageProviderCommandGoat]
		}
		models = usageFallbackModels(configuredKeys, UsageProviderCommandGoat, baseURL, prices)
	}
	plan := usageBasePlan(UsageProviderCommandGoat, true, usageStatusFor(windows))
	planName := "Coding Plan"
	if planID != nil {
		if named, ok := usageCommandPlanName[strings.ToLower(*planID)]; ok {
			planName = named
		} else {
			planName = *planID
		}
	}
	plan.Plan = providerStringPointer(planName)
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Windows = windows
	plan.Models = models
	plan.Balance = &UsageBalance{
		Remaining: &monthlyRemaining, Used: monthlyUsed, Total: monthlyTotal,
		Currency: providerStringPointer("USD"), Unit: providerStringPointer("$"),
	}
	plan.Details = UsageDetails{
		{Key: "已购额度", Value: usageNumberValue(credits["purchasedCredits"])},
		{Key: "赠送额度", Value: usageNumberValue(credits["freeCredits"])},
		{Key: "月度剩余", Value: monthlyRemaining},
	}
	return plan, nil
}

func usageMonthlyUsed(total, remaining float64) float64 {
	value := total - remaining
	if value < 0 {
		return 0
	}
	return value
}

func usageDeepSeekCredential(config *GraphConfig, env map[string]string) *usageCredential {
	return usageFirstCredential(
		usageSelectedCredential(env, UsageProviderDeepSeek, []string{"DEEPSEEK_API_KEY"}, usageDefaultBaseURLs[UsageProviderDeepSeek]),
		usageConfigCredential(config, env, UsageProviderDeepSeek, func(entry ConfiguredModel) bool {
			return strings.Contains(entry.BaseUrl, "api.deepseek.com") || strings.Contains(strings.ToLower(entry.Provider), "deepseek")
		}),
	)
}

func usageFetchDeepSeek(credential *usageCredential, prices []ModelPrice) (UsagePlan, error) {
	status, _, raw, err := usageFetch("GET", usageDeepSeekURL, map[string]string{
		"authorization": "Bearer " + credential.Value, "accept": "application/json",
	}, nil, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	body, err := usageResponseJSON(status, raw, "DeepSeek 余额")
	if err != nil {
		return UsagePlan{}, err
	}
	infos := []map[string]any{}
	for _, value := range usageArray(body["balance_infos"]) {
		if record := usageRecord(value); record != nil {
			infos = append(infos, record)
		}
	}
	var info map[string]any
	for _, candidate := range infos {
		if currency := usageText(candidate["currency"]); currency != nil && strings.ToUpper(*currency) == "CNY" {
			info = candidate
			break
		}
	}
	if info == nil {
		for _, candidate := range infos {
			if number(candidate["total_balance"]) != nil {
				info = candidate
				break
			}
		}
	}
	if info == nil && len(infos) > 0 {
		info = infos[0]
	}
	remaining := 0.0
	if value := number(info["total_balance"]); value != nil {
		remaining = *value
	}
	currency := "CNY"
	if value := usageText(info["currency"]); value != nil {
		currency = *value
	}
	available := true
	if value := boolean(body["is_available"]); value != nil {
		available = *value
	}
	discovered := usageDiscoverOpenAiCompatible(UsageProviderDeepSeek, credential, prices)
	models := discovered
	if len(models) == 0 {
		keys := []string{}
		for _, price := range prices {
			if strings.HasPrefix(strings.ToLower(price.ModelID), "deepseek-") {
				keys = append(keys, price.ModelID)
			}
		}
		baseURL := credential.BaseURL
		if baseURL == "" {
			baseURL = usageDefaultBaseURLs[UsageProviderDeepSeek]
		}
		models = usageFallbackModels(keys, UsageProviderDeepSeek, baseURL, prices)
	}
	plan := usageBasePlan(UsageProviderDeepSeek, true, UsageStatusOK)
	if !available {
		plan.Status = UsageStatusLimited
	}
	plan.Plan = providerStringPointer("API 余额")
	plan.CredentialSource = providerStringPointer(credential.Source)
	info2 := usageCredentialInfo(credential)
	plan.Credential = &info2
	plan.Models = models
	unit := "$"
	if currency == "CNY" {
		unit = "¥"
	}
	plan.Balance = &UsageBalance{Remaining: &remaining, Currency: providerStringPointer(currency), Unit: providerStringPointer(unit)}
	availableLabel := "可用"
	if !available {
		availableLabel = "余额不足"
	}
	plan.Details = UsageDetails{
		{Key: "可用状态", Value: availableLabel},
		{Key: "赠送余额", Value: usageNumberValue(info["granted_balance"])},
		{Key: "充值余额", Value: usageNumberValue(info["topped_up_balance"])},
	}
	return plan, nil
}
