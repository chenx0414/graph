package graph

import (
	"sort"
)

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
