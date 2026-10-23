package graph

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
