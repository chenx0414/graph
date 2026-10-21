package graph

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// CredentialConfig names an environment variable. The secret value is never stored.
type CredentialConfig struct {
	DisplayName        string `json:"displayName,omitempty"`
	SecretRef          string `json:"secretRef"`
	SharedLimitGroupId string `json:"sharedLimitGroupId,omitempty"`
	Platform           string `json:"platform,omitempty"`
}

// LimitsConfig is the token-cap table. A nil default budget means unlimited.
type LimitsConfig struct {
	Credentials         map[string]int `json:"credentials"`
	SharedGroups        map[string]int `json:"sharedGroups"`
	DefaultBudgetTokens *int           `json:"defaultBudgetTokens"`
}

// GraphSkills is the skill-library block the document is allowed to carry.
type GraphSkills struct {
	Sedimentation SedimentSettings `json:"sedimentation"`
}

// GraphModels is the configured directory and grade preferences.
type GraphModels struct {
	Entries     []ConfiguredModel   `json:"entries"`
	Preferences map[string][]string `json:"preferences"`
}

// GraphCodemode is the codemode block of the configuration.
//
// The kernel has codemode built in; Graph offers it only when the
// configuration asks for it. Off by default: a session that never asked for
// a sandbox never gets one.
type GraphCodemode struct {
	Enabled bool `json:"enabled"`
	// TimeoutMs is the deadline of one script, in milliseconds. Zero is the
	// kernel's own default.
	TimeoutMs *int `json:"timeoutMs,omitempty"`
}

// ConfiguredModel is a ModelEntry that always names its credential.
// ID, BaseURL, API, CredentialID and ModelID mirror the embedded entry for callers
// that spell those fields the way server_start.go does.
type ConfiguredModel struct {
	ModelEntry
	ID           string `json:"-"`
	BaseURL      string `json:"-"`
	API          string `json:"-"`
	CredentialID string `json:"-"`
	ModelID      string `json:"-"`
}

// GraphConfig is the versioned on-disk configuration.
type GraphConfig struct {
	Path                  *string                     `json:"path"`
	Configured            bool                        `json:"configured"`
	Projects              []ProjectConfig             `json:"projects"`
	Models                *GraphModels                `json:"models"`
	Credentials           map[string]CredentialConfig `json:"credentials"`
	Limits                LimitsConfig                `json:"limits"`
	Access                AccessPolicy                `json:"access"`
	Skills                GraphSkills                 `json:"skills"`
	PiExtensionAutoUpdate bool                        `json:"piExtensionAutoUpdate"`
	Codemode              GraphCodemode               `json:"codemode"`
}

// CredentialSecret is one resolved environment binding.
type CredentialSecret struct {
	Configured bool
	SecretRef  string
	Value      *string
}

var (
	configSecretRef = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	configFieldLead = regexp.MustCompile(`^[A-Za-z0-9_$.\[\]-]+`)
	configHeader    = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_` + "`" + `|~-]+$`)
)

func configInvalid(message string) {
	field := message
	if lead := configFieldLead.FindString(message); lead != "" {
		field = lead
	}
	RaiseField("invalid_config", message, field)
}

// EmptyGraphConfig is the unconfigured document.
func EmptyGraphConfig() GraphConfig {
	sediment := DEFAULT_SEDIMENT_SETTINGS
	return GraphConfig{
		Path: nil, Configured: false, Projects: []ProjectConfig{}, Models: nil,
		Credentials:           map[string]CredentialConfig{},
		Limits:                LimitsConfig{Credentials: map[string]int{}, SharedGroups: map[string]int{}, DefaultBudgetTokens: nil},
		Access:                FullAccessPolicy(),
		Skills:                GraphSkills{Sedimentation: sediment},
		PiExtensionAutoUpdate: true,
	}
}

// DefaultConfigPath is graph.config.json beside the working directory.
func DefaultConfigPath(cwd string) string {
	return filepath.Join(cwd, "graph.config.json")
}

// DefaultStateDir follows XDG_STATE_HOME, then ~/.local/state/graph.
func DefaultStateDir(env map[string]string) string {
	home := strings.TrimSpace(env["HOME"])
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	base := strings.TrimSpace(env["XDG_STATE_HOME"])
	if base == "" {
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "graph")
}

func asObject(value any, path string) map[string]any {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		configInvalid(path + " must be an object")
	}
	return object
}

func configAsArray(value any, path string) []any {
	items, ok := value.([]any)
	if !ok {
		configInvalid(path + " must be an array")
	}
	return items
}

func configAsString(value any, path string) string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		configInvalid(path + " must be a nonempty string")
	}
	return strings.TrimSpace(text)
}

func configOptionalBool(value any, path string, present bool) *bool {
	if !present {
		return nil
	}
	flag, ok := value.(bool)
	if !ok {
		configInvalid(path + " must be a boolean")
	}
	return &flag
}

func configFiniteInt(value any) (int, bool) {
	switch n := value.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n > 9007199254740991 || n < -9007199254740991 {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case int64:
		if n > 9007199254740991 || n < -9007199254740991 {
			return 0, false
		}
		return int(n), true
	case json.Number:
		parsed, err := n.Float64()
		if err != nil {
			return 0, false
		}
		return configFiniteInt(parsed)
	default:
		return 0, false
	}
}

func configPositiveInt(value any, path string) int {
	n, ok := configFiniteInt(value)
	if !ok || n <= 0 {
		configInvalid(path + " must be a positive integer")
	}
	return n
}

func configParseSkills(value any, models *GraphModels, present bool) GraphSkills {
	sediment := DEFAULT_SEDIMENT_SETTINGS
	if !present {
		return GraphSkills{Sedimentation: sediment}
	}
	root := asObject(value, "skills")
	raw, rawPresent := root["sedimentation"]
	var block map[string]any
	if rawPresent {
		block = asObject(raw, "skills.sedimentation")
	}
	var model *string
	if block != nil {
		if current, ok := block["model"]; ok && current != nil {
			text := configAsString(current, "skills.sedimentation.model")
			model = &text
		}
	}
	if model != nil && models != nil {
		found := false
		for _, entry := range models.Entries {
			if entry.Id == *model {
				found = true
				break
			}
		}
		if !found {
			configInvalid("skills.sedimentation.model references unknown model \"" + *model + "\"")
		}
	}
	enabled := false
	if block != nil {
		if flag := configOptionalBool(block["enabled"], "skills.sedimentation.enabled", mapHas(block, "enabled")); flag != nil {
			enabled = *flag
		}
	}
	after := sediment.AfterToolCalls
	budget := sediment.BudgetTokens
	if block != nil {
		if _, ok := block["afterToolCalls"]; ok {
			after = configPositiveInt(block["afterToolCalls"], "skills.sedimentation.afterToolCalls")
		}
		if _, ok := block["budgetTokens"]; ok {
			budget = configPositiveInt(block["budgetTokens"], "skills.sedimentation.budgetTokens")
		}
	}
	sediment.Enabled = enabled
	sediment.AfterToolCalls = after
	sediment.Model = model
	sediment.BudgetTokens = budget
	return GraphSkills{Sedimentation: sediment}
}

func configAsCost(value any, path string) ModelCost {
	raw := asObject(value, path)
	field := func(name string) float64 {
		current, ok := raw[name]
		if !ok {
			configInvalid(path + "." + name + " must be a nonnegative number")
		}
		number, isFloat := current.(float64)
		if !isFloat {
			if parsed, ok := configFiniteInt(current); ok {
				number = float64(parsed)
				isFloat = true
			}
		}
		if !isFloat || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
			configInvalid(path + "." + name + " must be a nonnegative number")
		}
		return number
	}
	return ModelCost{Input: field("input"), Output: field("output"), CacheRead: field("cacheRead"), CacheWrite: field("cacheWrite")}
}

func configAsPricing(value any, path string) ModelPricing {
	raw := asObject(value, path)
	status := "known"
	if _, ok := raw["status"]; ok {
		status = configAsString(raw["status"], path+".status")
	}
	if status != "known" && status != "stale" && status != "unknown" {
		configInvalid(path + ".status must be known, stale or unknown")
	}
	if raw["unit"] != "per_million_tokens" {
		configInvalid(path + ".unit must be \"per_million_tokens\"")
	}
	pricing := ModelPricing{
		Currency: configAsString(raw["currency"], path+".currency"),
		Unit:     "per_million_tokens",
		Status:   status,
	}
	if text := configOptionalPresent(raw, "sourceUrl", path+".sourceUrl"); text != "" {
		pricing.SourceUrl = text
	}
	if text := configOptionalPresent(raw, "retrievedAt", path+".retrievedAt"); text != "" {
		pricing.RetrievedAt = text
	}
	if text := configOptionalPresent(raw, "catalogRevision", path+".catalogRevision"); text != "" {
		pricing.CatalogRevision = text
	}
	return pricing
}

func configOptionalPresent(raw map[string]any, name, path string) string {
	value, ok := raw[name]
	if !ok || value == nil {
		return ""
	}
	return configAsString(value, path)
}

func configAsHeaders(value any, path string) map[string]string {
	entries := asObject(value, path)
	if len(entries) > 20 {
		configInvalid(path + " must declare at most 20 headers")
	}
	headers := map[string]string{}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !configHeader.MatchString(name) {
			configInvalid(path + "." + name + " is not a valid header name")
		}
		header, ok := entries[name].(string)
		if !ok || header == "" || len(header) > 512 {
			configInvalid(path + "." + name + " must be a non-empty string of at most 512 characters")
		}
		headers[name] = header
	}
	return headers
}

func configGradeOK(grade string) bool {
	for _, item := range MODEL_GRADES {
		if string(item) == grade {
			return true
		}
	}
	return false
}

func configThinkingLevel(value any, path string) ModelThinkingLevel {
	level := configAsString(value, path)
	for _, item := range MODEL_THINKING_LEVELS {
		if string(item) == level {
			return item
		}
	}
	configInvalid(path + " must be one of " + configJoinGrades(MODEL_THINKING_LEVELS))
	return ""
}

func configJoinGrades[T ~string](items []T) string {
	parts := make([]string, len(items))
	for i, item := range items {
		parts[i] = string(item)
	}
	return strings.Join(parts, ", ")
}

func configModelInputs(value any, path string) []ModelInput {
	items := configAsArray(value, path)
	if len(items) == 0 {
		configInvalid(path + " must contain at least one input modality")
	}
	values := make([]ModelInput, len(items))
	seen := map[string]bool{}
	hasText := false
	for index, item := range items {
		text := configAsString(item, path+"["+itoa(index)+"]")
		allowed := false
		for _, input := range MODEL_INPUTS {
			if string(input) == text {
				allowed = true
				values[index] = input
				break
			}
		}
		if !allowed {
			configInvalid(path + " contains unsupported input modality \"" + text + "\"")
		}
		if text == "text" {
			hasText = true
		}
		if seen[text] {
			configInvalid(path + " must not contain duplicate input modalities")
		}
		seen[text] = true
	}
	if !hasText {
		configInvalid(path + " must include \"text\"")
	}
	return values
}

func configParseModel(raw any, path string, credentials map[string]CredentialConfig) ConfiguredModel {
	entry := asObject(raw, path)
	grade := configAsString(entry["grade"], path+".grade")
	if !configGradeOK(grade) {
		configInvalid(path + ".grade must be one of " + configJoinGrades(MODEL_GRADES))
	}
	api := configAsString(entry["api"], path+".api")
	if api != "openai-completions" && api != "anthropic-messages" {
		configInvalid(path + ".api must be \"openai-completions\" or \"anthropic-messages\"")
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
	limits := LimitsConfig{Credentials: map[string]int{}, SharedGroups: map[string]int{}, DefaultBudgetTokens: nil}
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
		if current, present := rawLimits["defaultBudgetTokens"]; present && current != nil {
			budget := configPositiveInt(current, "limits.defaultBudgetTokens")
			limits.DefaultBudgetTokens = &budget
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

// configParseCodemode reads the codemode block of the configuration.
//
// The block is optional and off by default: the kernel has codemode, but
// Graph only offers it when the configuration says so.
func configParseCodemode(value any) GraphCodemode {
	codemode := GraphCodemode{}
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

// LoadGraphConfig reads and parses one file. A missing file is invalid_config.
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

// AssertCredentialGroups rejects aliases of one key that name different shared groups.
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

// ResolveCredentialSecret reads the environment variable a credential names.
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
