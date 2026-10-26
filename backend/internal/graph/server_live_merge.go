package graph

import (
	"sort"
)

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
