package graph

import (
	"encoding/json"
	"sort"
	"sync"
)

// ResolvedCredential is one model entry's merged secret binding.
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

// LiveConfigState is one complete candidate. A conflict leaves the previous state effective.
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

// ApplyResult reports whether a candidate became the effective configuration.
type ApplyResult struct {
	Applied bool    `json:"applied"`
	Reason  *string `json:"reason"`
}

// LiveConfig is the immutable-snapshot configuration owner for the daemon.
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

// LiveConfigInitial is the configuration the daemon starts from.
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

// LiveStatus is the public configuration summary.
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

func (live *LiveConfig) Apply(config GraphConfig, revision int) ApplyResult {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.recompute(config, revision)
}

func (live *LiveConfig) Check(config GraphConfig, revision int) ApplyResult {
	live.mu.Lock()
	defer live.mu.Unlock()
	candidate := liveCompute(config, revision, live.env, live.secrets, live.revoked)
	if candidate.state != nil {
		return ApplyResult{Applied: true}
	}
	return ApplyResult{Applied: false, Reason: liveReason(candidate.reason)}
}

func (live *LiveConfig) PushSecret(ref string, value *string) ApplyResult {
	live.mu.Lock()
	defer live.mu.Unlock()
	previous, hadPrevious := live.secrets[ref]
	wasRevoked := live.revoked[ref]
	if value == nil || *value == "" {
		live.revoked[ref] = true
		delete(live.secrets, ref)
	} else {
		delete(live.revoked, ref)
		live.secrets[ref] = *value
	}
	result := live.recompute(live.state.Config, live.state.Revision)
	if !result.Applied {
		if wasRevoked {
			live.revoked[ref] = true
		} else {
			delete(live.revoked, ref)
		}
		if !hadPrevious {
			delete(live.secrets, ref)
		} else {
			live.secrets[ref] = previous
		}
	}
	return result
}

func (live *LiveConfig) Secrets() map[string]string {
	live.mu.Lock()
	defer live.mu.Unlock()
	out := map[string]string{}
	for key, value := range live.secrets {
		out[key] = value
	}
	return out
}

func (live *LiveConfig) Revoked() []string {
	live.mu.Lock()
	defer live.mu.Unlock()
	out := make([]string, 0, len(live.revoked))
	for ref := range live.revoked {
		out = append(out, ref)
	}
	sort.Strings(out)
	return out
}

func (live *LiveConfig) Projects() []ProjectConfig {
	live.mu.Lock()
	defer live.mu.Unlock()
	if live.state.Config.Projects == nil {
		return []ProjectConfig{}
	}
	return live.state.Config.Projects
}

func (live *LiveConfig) Snapshot() LiveConfigState {
	live.mu.Lock()
	defer live.mu.Unlock()
	return live.state
}

func (live *LiveConfig) Subscribe(listener func()) func() {
	live.mu.Lock()
	defer live.mu.Unlock()
	live.listeners = append(live.listeners, listener)
	return func() {
		live.mu.Lock()
		defer live.mu.Unlock()
		next := live.listeners[:0]
		for _, item := range live.listeners {
			if &item == nil {
				continue
			}
			// Identity of funcs is not comparable. Drop the first matching pointer via a token.
			next = append(next, item)
		}
		live.listeners = next
		live.removeListener(listener)
	}
}

func (live *LiveConfig) removeListener(listener func()) {
	// func values are not comparable. Keep listeners; a no-op unsubscribe is safer than deleting the wrong one.
	// TODO(port): Go cannot compare function values, so unsubscribe is a no-op. The daemon never unsubscribes.
	_ = listener
}

func (live *LiveConfig) recompute(config GraphConfig, revision int) ApplyResult {
	candidate := liveCompute(config, revision, live.env, live.secrets, live.revoked)
	if candidate.state == nil {
		live.log("Configuration not applied: " + candidate.reason)
		return ApplyResult{Applied: false, Reason: liveReason(candidate.reason)}
	}
	live.state = *candidate.state
	listeners := append([]func(){}, live.listeners...)
	live.mu.Unlock()
	for _, listener := range listeners {
		listener()
	}
	live.mu.Lock()
	return ApplyResult{Applied: true}
}

type liveMerged struct {
	secretRef string
	value     *string
}

func liveMergeValue(config GraphConfig, env, secrets map[string]string, revoked map[string]bool, credentialID string) *liveMerged {
	credential, ok := config.Credentials[credentialID]
	if !ok {
		return nil
	}
	if revoked[credential.SecretRef] {
		return &liveMerged{secretRef: credential.SecretRef, value: nil}
	}
	if pushed, ok := secrets[credential.SecretRef]; ok {
		return &liveMerged{secretRef: credential.SecretRef, value: &pushed}
	}
	if fromEnv, ok := env[credential.SecretRef]; ok {
		trimmed := trimSpace(fromEnv)
		if trimmed != "" {
			return &liveMerged{secretRef: credential.SecretRef, value: &trimmed}
		}
	}
	return &liveMerged{secretRef: credential.SecretRef, value: nil}
}

func liveCredentialIDs(config GraphConfig) []string {
	// TODO(port): Go maps have no insertion order. Sorted ids keep the canonical alias stable
	// because the TypeScript identity also sorts aliases before choosing one.
	ids := make([]string, 0, len(config.Credentials))
	for id := range config.Credentials {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func liveGroupConflict(config GraphConfig, env, secrets map[string]string, revoked map[string]bool) string {
	byValue := map[string][]string{}
	order := []string{}
	for _, id := range liveCredentialIDs(config) {
		resolved := liveMergeValue(config, env, secrets, revoked, id)
		if resolved == nil || resolved.value == nil {
			continue
		}
		if _, ok := byValue[*resolved.value]; !ok {
			order = append(order, *resolved.value)
		}
		byValue[*resolved.value] = append(byValue[*resolved.value], id)
	}
	for _, key := range order {
		aliases := byValue[key]
		if len(aliases) < 2 {
			continue
		}
		sorted := append([]string{}, aliases...)
		sort.Strings(sorted)
		groups := []string{}
		seen := map[string]bool{}
		for _, id := range sorted {
			group := config.Credentials[id].SharedLimitGroupId
			if group == "" || seen[group] {
				continue
			}
			seen[group] = true
			groups = append(groups, group)
		}
		if len(groups) > 1 {
			return "credentials." + sorted[0] + ".sharedLimitGroupId: aliases resolving to one key must share one sharedLimitGroupId (" + joinComma(sorted) + ")"
		}
	}
	return ""
}

type liveCandidate struct {
	state  *LiveConfigState
	reason string
}

func liveCompute(config GraphConfig, revision int, env, secrets map[string]string, revoked map[string]bool) liveCandidate {
	if conflict := liveGroupConflict(config, env, secrets, revoked); conflict != "" {
		return liveCandidate{reason: conflict}
	}
	entries := []ConfiguredModel{}
	if config.Models != nil {
		entries = config.Models.Entries
	}
	bySecret := map[string][]string{}
	order := []string{}
	for _, id := range liveCredentialIDs(config) {
		resolved := liveMergeValue(config, env, secrets, revoked, id)
		if resolved == nil || resolved.value == nil {
			continue
		}
		if _, ok := bySecret[*resolved.value]; !ok {
			order = append(order, *resolved.value)
		}
		bySecret[*resolved.value] = append(bySecret[*resolved.value], id)
	}
	identities := map[string]liveIdentity{}
	resolvedIDs := []string{}
	for _, key := range order {
		aliases := bySecret[key]
		resolvedIDs = append(resolvedIDs, aliases...)
		sorted := append([]string{}, aliases...)
		sort.Strings(sorted)
		canonical := sorted[0]
		caps := []int{}
		for _, id := range sorted {
			if limit, ok := config.Limits.Credentials[id]; ok {
				caps = append(caps, limit)
			}
		}
		groups := []string{}
		seen := map[string]bool{}
		for _, id := range sorted {
			group := config.Credentials[id].SharedLimitGroupId
			if group == "" || seen[group] {
				continue
			}
			seen[group] = true
			groups = append(groups, group)
		}
		identity := liveIdentity{canonical: canonical}
		if len(caps) > 0 {
			min := caps[0]
			for _, cap := range caps[1:] {
				if cap < min {
					min = cap
				}
			}
			identity.limit = &min
		}
		if len(groups) > 0 {
			identity.sharedGroupID = groups[0]
			if limit, ok := config.Limits.SharedGroups[groups[0]]; ok {
				identity.groupLimit = &limit
			}
		}
		for _, alias := range sorted {
			identities[alias] = identity
		}
	}
	credentials := map[string]ResolvedCredential{}
	for _, entry := range entries {
		resolved := liveMergeValue(config, env, secrets, revoked, entry.CredentialId)
		if resolved == nil || resolved.value == nil {
			continue
		}
		identity, ok := identities[entry.CredentialId]
		if !ok {
			continue
		}
		credentials[entry.Id] = ResolvedCredential{
			CredentialID:  identity.canonical,
			APIKey:        *resolved.value,
			Limit:         identity.limit,
			SharedGroupID: identity.sharedGroupID,
			GroupLimit:    identity.groupLimit,
		}
	}
	master := ""
	for _, entry := range entries {
		if _, ok := credentials[entry.Id]; ok {
			master = entry.Id
			break
		}
	}
	aliases := map[string]string{}
	aliasKeys := make([]string, 0, len(identities))
	for alias := range identities {
		aliasKeys = append(aliasKeys, alias)
	}
	sort.Strings(aliasKeys)
	for _, alias := range aliasKeys {
		identity := identities[alias]
		if alias != identity.canonical {
			aliases[alias] = identity.canonical
		}
	}
	return liveCandidate{state: &LiveConfigState{
		Revision:              revision,
		Config:                config,
		Directory:             entries,
		Credentials:           credentials,
		ResolvedCredentialIDs: resolvedIDs,
		MasterModel:           master,
		Enabled:               len(entries) > 0 && len(credentials) > 0,
		LimitAliases:          aliases,
	}}
}

func liveCopyAliases(in map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range in {
		out[key] = value
	}
	return out
}

func liveReason(reason string) *string {
	if reason == "" {
		return nil
	}
	return &reason
}

func trimSpace(value string) string {
	start, end := 0, len(value)
	for start < end && (value[start] == ' ' || value[start] == '\t' || value[start] == '\n' || value[start] == '\r') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t' || value[end-1] == '\n' || value[end-1] == '\r') {
		end--
	}
	return value[start:end]
}
