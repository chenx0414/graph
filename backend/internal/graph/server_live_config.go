package graph

import (
	"sync"

	"encoding/json"
)

type ResolvedCredential struct {
	CredentialID  string
	APIKey        string
	Limit         *int
	SharedGroupID string
	GroupLimit    *int
}

type liveIdentity struct {
	canonical     string
	limit         *int
	sharedGroupID string
	groupLimit    *int
}

type LiveConfigState struct {
	Revision              int
	Config                GraphConfig
	Directory             []ConfiguredModel
	Credentials           map[string]ResolvedCredential
	ResolvedCredentialIDs []string
	MasterModel           string
	Enabled               bool
	LimitAliases          map[string]string
	Conflict              string
}

type ApplyResult struct {
	Applied bool    `json:"applied"`
	Reason  *string `json:"reason"`
}

type LiveConfig struct {
	mu        sync.Mutex
	env       map[string]string
	log       func(string)
	secrets   map[string]string
	revoked   map[string]bool
	state     LiveConfigState
	listeners []func()
}

type LiveConfigOptions struct {
	Env     map[string]string
	Log     func(string)
	Initial LiveConfigInitial
	Secrets map[string]string
	Revoked []string
}

type LiveConfigInitial struct {
	Config   GraphConfig
	Revision int
}

func CreateLiveConfig(options LiveConfigOptions) *LiveConfig {
	log := options.Log
	if log == nil {
		log = func(string) {}
	}
	secrets := map[string]string{}
	for key, value := range options.Secrets {
		secrets[key] = value
	}
	revoked := map[string]bool{}
	for _, ref := range options.Revoked {
		revoked[ref] = true
	}
	live := &LiveConfig{env: options.Env, log: log, secrets: secrets, revoked: revoked}
	initial := liveCompute(options.Initial.Config, options.Initial.Revision, options.Env, secrets, revoked)
	if initial.state != nil {
		live.state = *initial.state
	} else {
		entries := []ConfiguredModel{}
		if options.Initial.Config.Models != nil {
			entries = options.Initial.Config.Models.Entries
		}
		live.state = LiveConfigState{
			Revision:              options.Initial.Revision,
			Config:                options.Initial.Config,
			Directory:             entries,
			Credentials:           map[string]ResolvedCredential{},
			ResolvedCredentialIDs: []string{},
			LimitAliases:          map[string]string{},
			Conflict:              initial.reason,
		}
	}
	return live
}

func (live *LiveConfig) Revision() int {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state.Revision
}

func (live *LiveConfig) Config() GraphConfig {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state.Config
}

func (live *LiveConfig) Entries() []ConfiguredModel {
	live.mu.Lock()
	defer live.mu.Unlock()
	return append([]ConfiguredModel{}, live.state.Directory...)
}

func (live *LiveConfig) Preferences() map[string][]string {
	live.mu.Lock()
	defer live.mu.Unlock()
	if live.state.Config.Models == nil || live.state.Config.Models.Preferences == nil {
		return map[string][]string{}
	}
	return live.state.Config.Models.Preferences
}

func (live *LiveConfig) CredentialFor(entry ConfiguredModel) *ResolvedCredential {
	live.mu.Lock()
	defer live.mu.Unlock()
	value, ok := live.state.Credentials[entry.Id]
	if !ok {
		return nil
	}
	copy := value
	return &copy
}

func (live *LiveConfig) MasterModel() string {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state.MasterModel
}

func (live *LiveConfig) DefaultBudgetTokens() *int {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state.Config.Limits.DefaultBudgetTokens
}

func (live *LiveConfig) Access() AccessPolicy {
	live.mu.Lock()
	config := live.state.Config.Access
	live.mu.Unlock()
	raw, err := json.Marshal(config)
	if err != nil {
		panic(err)
	}
	var copy AccessPolicy
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func (live *LiveConfig) Enabled() bool {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state.Enabled
}

func (live *LiveConfig) Status() LiveStatus {
	live.mu.Lock()
	defer live.mu.Unlock()
	return LiveStatus{
		Configured:        live.state.Enabled,
		ModelCount:        len(live.state.Directory),
		EnabledModelCount: len(live.state.Credentials),
		EffectiveRevision: live.state.Revision,
		LimitAliases:      liveCopyAliases(live.state.LimitAliases),
	}
}

type LiveStatus struct {
	Configured        bool              `json:"configured"`
	ModelCount        int               `json:"modelCount"`
	EnabledModelCount int               `json:"enabledModelCount"`
	EffectiveRevision int               `json:"effectiveRevision"`
	LimitAliases      map[string]string `json:"limitAliases"`
}

func (live *LiveConfig) ResolvedCredentialIDs() []string {
	live.mu.Lock()
	defer live.mu.Unlock()
	return append([]string{}, live.state.ResolvedCredentialIDs...)
}

func (live *LiveConfig) Snapshot() LiveConfigState {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state
}

func (live *LiveConfig) removeListener() {}

type liveMerged struct {
	secretRef string
	value     *string
}

type liveCandidate struct {
	state  *LiveConfigState
	reason string
}
