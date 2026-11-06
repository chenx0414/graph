package graph

import (
	"path/filepath"
	"strings"
)

func configParseModel(raw any, path string, credentials map[string]CredentialConfig) ConfiguredModel {
	entry := asObject(raw, path)
	grade := configAsString(entry["grade"], path+".grade")
	if !configGradeOK(grade) {
		configInvalid(path + ".grade must be one of " + configJoinGrades(MODEL_GRADES))
	}
	api := configAsString(entry["api"], path+".api")
	if api != "openai-completions" && api != "anthropic-messages" && api != "openai-responses" {
		configInvalid(path + ".api must be \"openai-completions\", \"openai-responses\" or \"anthropic-messages\"")
	}
	credentialID := configAsString(entry["credentialId"], path+".credentialId")
	if _, ok := credentials[credentialID]; !ok {
		configInvalid(path + ".credentialId references unknown credential \"" + credentialID + "\"")
	}
	reasoning := true
	if flag := configOptionalBool(entry["reasoning"], path+".reasoning", mapHas(entry, "reasoning")); flag != nil {
		reasoning = *flag
	}
	model := ModelEntry{
		Id: entryID(entry, path), Provider: configAsString(entry["provider"], path+".provider"),
		Grade: ModelGrade(grade), Api: ModelApi(api),
		BaseUrl:       configAsString(entry["baseUrl"], path+".baseUrl"),
		ContextWindow: configPositiveInt(entry["contextWindow"], path+".contextWindow"),
		MaxTokens:     configPositiveInt(entry["maxTokens"], path+".maxTokens"),
		Reasoning:     &reasoning, CredentialId: credentialID,
	}
	if _, ok := entry["input"]; ok {
		model.Input = configModelInputs(entry["input"], path+".input")
	}
	if _, ok := entry["defaultThinkingLevel"]; ok {
		model.DefaultThinkingLevel = configThinkingLevel(entry["defaultThinkingLevel"], path+".defaultThinkingLevel")
	}
	if _, ok := entry["fallbackModelId"]; ok {
		fallback := configAsString(entry["fallbackModelId"], path+".fallbackModelId")
		if fallback == "" {
			configInvalid(path + ".fallbackModelId must name a model id")
		}
		model.FallbackModelId = fallback
	}
	modelID := ""
	if _, ok := entry["modelId"]; ok {
		modelID = configAsString(entry["modelId"], path+".modelId")
		model.ModelId = modelID
	}
	if _, ok := entry["cost"]; ok {
		cost := configAsCost(entry["cost"], path+".cost")
		model.Cost = &cost
	}
	if _, ok := entry["pricing"]; ok {
		pricing := configAsPricing(entry["pricing"], path+".pricing")
		model.Pricing = &pricing
	}
	if _, ok := entry["headers"]; ok {
		model.Headers = configAsHeaders(entry["headers"], path+".headers")
	}
	return ConfiguredModel{ModelEntry: model, ID: model.Id, BaseURL: model.BaseUrl, API: string(model.Api), CredentialID: credentialID, ModelID: modelID}
}

func entryID(entry map[string]any, path string) string {
	return configAsString(entry["id"], path+".id")
}

// ParseGraphConfig reads a version-1 document. Relative project roots resolve against the file directory.
func ParseGraphConfig(raw any, configPath string) GraphConfig {
	root := asObject(raw, configPath)
	if version, ok := configFiniteInt(root["version"]); !ok || version != 1 {
		configInvalid(configPath + ": version must be 1")
	}
	dir := filepath.Dir(configPath)
	credentials := map[string]CredentialConfig{}
	if value, ok := root["credentials"]; ok {
		for id, item := range asObject(value, "credentials") {
			path := "credentials." + id
			record := asObject(item, path)
			secretRef := configAsString(record["secretRef"], path+".secretRef")
			if !configSecretRef.MatchString(secretRef) {
				configInvalid(path + ".secretRef must be an environment variable name")
			}
			credential := CredentialConfig{SecretRef: secretRef}
			if _, present := record["displayName"]; present {
				credential.DisplayName = configAsString(record["displayName"], path+".displayName")
			}
			if _, present := record["sharedLimitGroupId"]; present {
				credential.SharedLimitGroupId = configAsString(record["sharedLimitGroupId"], path+".sharedLimitGroupId")
			}
			if _, present := record["platform"]; present {
				platform := strings.TrimSpace(configAsString(record["platform"], path+".platform"))
				if platform == "" {
					configInvalid(path + ".platform must name the subscription platform it is an account of")
				}
				credential.Platform = platform
			}
			credentials[id] = credential
		}
	}
	limits := LimitsConfig{Credentials: map[string]int{}, SharedGroups: map[string]int{}, }
	if value, ok := root["limits"]; ok {
		rawLimits := asObject(value, "limits")
		credentialLimits := map[string]any{}
		if current, present := rawLimits["credentials"]; present {
			credentialLimits = asObject(current, "limits.credentials")
		}
		for id, item := range credentialLimits {
			if _, known := credentials[id]; !known {
				configInvalid("limits.credentials." + id + " references unknown credential \"" + id + "\"")
			}
			limits.Credentials[id] = configPositiveInt(item, "limits.credentials."+id)
		}
		groups := map[string]any{}
		if current, present := rawLimits["sharedGroups"]; present {
			groups = asObject(current, "limits.sharedGroups")
		}
		for id, item := range groups {
			limits.SharedGroups[id] = configPositiveInt(item, "limits.sharedGroups."+id)
		}
	}
	projects := []ProjectConfig{}
	if value, ok := root["projects"]; ok {
		seen := map[string]bool{}
		for index, item := range configAsArray(value, "projects") {
			path := "projects[" + itoa(index) + "]"
			record := asObject(item, path)
			id := configAsString(record["id"], path+".id")
			if seen[id] {
				configInvalid("duplicate project id \"" + id + "\"")
			}
			seen[id] = true
			rawRoot := configAsString(record["root"], path+".root")
			resolved := rawRoot
			if !filepath.IsAbs(rawRoot) {
				resolved = filepath.Join(dir, rawRoot)
			}
			resolved = filepath.Clean(resolved)
			project := ProjectConfig{Id: id, Root: resolved}
			if grants, present := record["grants"]; present {
				items := configAsArray(grants, path+".grants")
				project.Grants = make([]string, len(items))
				for position, grant := range items {
					project.Grants[position] = configAsString(grant, path+".grants["+itoa(position)+"]")
				}
			}
			projects = append(projects, project)
		}
	}
	var models *GraphModels
	if value, ok := root["models"]; ok {
		rawModels := asObject(value, "models")
		seen := map[string]bool{}
		items := configAsArray(rawModels["entries"], "models.entries")
		entries := make([]ConfiguredModel, len(items))
		for index, item := range items {
			parsed := configParseModel(item, "models.entries["+itoa(index)+"]", credentials)
			if seen[parsed.Id] {
				configInvalid("duplicate model id \"" + parsed.Id + "\"")
			}
			seen[parsed.Id] = true
			entries[index] = parsed
		}
		if len(entries) == 0 {
			configInvalid("models.entries must not be empty")
		}
		type providerBinding struct{ credentialID, baseURL string }
		byProvider := map[string]providerBinding{}
		for index, entry := range entries {
			existing, ok := byProvider[entry.Provider]
			if !ok {
				byProvider[entry.Provider] = providerBinding{credentialID: entry.CredentialID, baseURL: entry.BaseURL}
				continue
			}
			if existing.credentialID != entry.CredentialID {
				configInvalid("models.entries[" + itoa(index) + "].credentialId: provider \"" + entry.Provider + "\" must use one credentialId across its models")
			}
			if existing.baseURL != entry.BaseURL {
				configInvalid("models.entries[" + itoa(index) + "].baseUrl: provider \"" + entry.Provider + "\" must use one baseUrl across its models")
			}
		}
		// A fallback is one hop to a model that exists: a chain would make the
		// same review silently walk an unknown number of providers, and a
		// fallback to itself would pretend to have switched.
		for index, entry := range entries {
			if entry.FallbackModelId == "" {
				continue
			}
			if entry.FallbackModelId == entry.Id {
				configInvalid("models.entries[" + itoa(index) + "].fallbackModelId must name another model, not itself")
			}
			if !seen[entry.FallbackModelId] {
				configInvalid("models.entries[" + itoa(index) + "].fallbackModelId references unknown model \"" + entry.FallbackModelId + "\"")
			}
			for _, other := range entries {
				if other.Id == entry.FallbackModelId && other.FallbackModelId != "" {
					configInvalid("models.entries[" + itoa(index) + "].fallbackModelId: \"" + other.Id + "\" has its own fallback; a fallback is one hop")
				}
			}
		}
		preferences := map[string][]string{}
		if rawPreferences, present := rawModels["preferences"]; present {
			for grade, ids := range asObject(rawPreferences, "models.preferences") {
				if !configGradeOK(grade) {
					configInvalid("models.preferences." + grade + " is not a model grade")
				}
				items := configAsArray(ids, "models.preferences."+grade)
				values := make([]string, len(items))
				for index, id := range items {
					text := configAsString(id, "models.preferences."+grade+"["+itoa(index)+"]")
					if !seen[text] {
						configInvalid("models.preferences." + grade + " references unknown model \"" + text + "\"")
					}
					values[index] = text
				}
				preferences[grade] = values
			}
		}
		models = &GraphModels{Entries: entries, Preferences: preferences}
	}
	_, skillsPresent := root["skills"]
	pathCopy := configPath
	return GraphConfig{
		Path: &pathCopy, Configured: true, Projects: projects, Models: models, Credentials: credentials, Limits: limits,
		Access: ParseAccessPolicy(root["access"], "access"),
		Skills: configParseSkills(root["skills"], models, skillsPresent),
		PiExtensionAutoUpdate: func() bool {
			if flag := configOptionalBool(root["piExtensionAutoUpdate"], "piExtensionAutoUpdate", mapHas(root, "piExtensionAutoUpdate")); flag != nil {
				return *flag
			}
			return true
		}(),
		Codemode: configParseCodemode(root["codemode"]),
	}
}
