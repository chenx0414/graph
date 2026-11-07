package graph

import (
	"os"
	"sort"
	"strings"

	"encoding/json"
)

func configParseCodemode(value any) GraphCodemode {
	codemode := GraphCodemode{Enabled: true}
	if value == nil {
		return codemode
	}
	record := asObject(value, "codemode")
	if flag := configOptionalBool(record["enabled"], "codemode.enabled", mapHas(record, "enabled")); flag != nil {
		codemode.Enabled = *flag
	}
	if current, present := record["timeoutMs"]; present && current != nil {
		timeout := configPositiveInt(current, "codemode.timeoutMs")
		codemode.TimeoutMs = &timeout
	}
	return codemode
}

func LoadGraphConfig(configPath string) GraphConfig {
	text, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			configInvalid("Config file not found: " + configPath)
		}
		panic(err)
	}
	var raw any
	if err := json.Unmarshal(text, &raw); err != nil {
		configInvalid(configPath + " is not valid JSON: " + err.Error())
	}
	return ParseGraphConfig(raw, configPath)
}

func AssertCredentialGroups(config GraphConfig, env map[string]string) {
	pointers := map[string]*string{}
	for key, value := range env {
		copied := value
		pointers[key] = &copied
	}
	byValue := map[string][]string{}
	ids := make([]string, 0, len(config.Credentials))
	for id := range config.Credentials {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		secret := ResolveCredentialSecret(config, id, pointers)
		if !secret.Configured || secret.Value == nil {
			continue
		}
		byValue[*secret.Value] = append(byValue[*secret.Value], id)
	}
	for _, aliases := range byValue {
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
			configInvalid("credentials." + sorted[0] + ".sharedLimitGroupId: aliases resolving to one key must share one sharedLimitGroupId (" + strings.Join(sorted, ", ") + ")")
		}
	}
}

func ResolveCredentialSecret(config GraphConfig, credentialID string, env map[string]*string) CredentialSecret {
	credential, ok := config.Credentials[credentialID]
	if !ok {
		return CredentialSecret{Configured: false, SecretRef: ""}
	}
	raw := env[credential.SecretRef]
	if raw == nil {
		return CredentialSecret{Configured: false, SecretRef: credential.SecretRef}
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return CredentialSecret{Configured: false, SecretRef: credential.SecretRef}
	}
	return CredentialSecret{Configured: true, SecretRef: credential.SecretRef, Value: &value}
}
