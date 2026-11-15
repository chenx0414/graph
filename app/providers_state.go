package main

type providerState string

const (
	providerUnconfigured providerState = "unconfigured"
	providerUnresolved   providerState = "unresolved"
	providerConnected    providerState = "connected"
	providerDisabled     providerState = "disabled"
)

type providerFacts struct {
	Configured bool
	Resolved   *bool
}

type providerSeverity string

const (
	providerAttention providerSeverity = "attention"
	providerOK        providerSeverity = "ok"
	providerQuiet     providerSeverity = "quiet"
)

func providerStateOf(facts providerFacts, enabled bool) providerState {
	switch {
	case !facts.Configured:
		return providerUnconfigured
	case facts.Resolved != nil && !*facts.Resolved:
		return providerUnresolved
	case !enabled:
		return providerDisabled
	}
	return providerConnected
}

func (state providerState) Label() string {
	switch state {
	case providerConnected:
		return "已连接"
	case providerDisabled:
		return "未启用"
	case providerUnresolved:
		return "凭据缺失"
	}
	return "未配置"
}

func (state providerState) Severity() providerSeverity {
	switch state {
	case providerConnected:
		return providerOK
	case providerUnconfigured, providerUnresolved:
		return providerAttention
	}
	return providerQuiet
}

func (state providerState) Authenticated() bool {
	return state == providerConnected
}

func (state providerState) MissingKey() bool {
	return state == providerUnconfigured || state == providerUnresolved
}

type providersPhase string

const (
	providersIdlePhase    providersPhase = "idle"
	providersLoadingPhase providersPhase = "loading"
	providersReadyPhase   providersPhase = "ready"
	providersEmptyPhase   providersPhase = "empty"
	providersFailedPhase  providersPhase = "failed"
)

func providersPhaseOf(loading, attempted bool, failed string, total int) providersPhase {
	switch {
	case total > 0:
		return providersReadyPhase
	case failed != "":
		return providersFailedPhase
	case loading:
		return providersLoadingPhase
	case !attempted:
		return providersIdlePhase
	}
	return providersEmptyPhase
}

func (phase providersPhase) Message(query string) string {
	switch phase {
	case providersIdlePhase, providersLoadingPhase:
		return "正在读取供应商…"
	case providersEmptyPhase:
		if query != "" {
			return "没有匹配的供应商。"
		}
		return "还没有供应商。"
	}
	return ""
}

func providersMatching(entries []providerEntry, query string) []providerEntry {
	if query == "" {
		return entries
	}
	matched := make([]providerEntry, 0, len(entries))
	for _, entry := range entries {
		if composerMatches(query, entry.Label, entry.ID) {
			matched = append(matched, entry)
		}
	}
	return matched
}
